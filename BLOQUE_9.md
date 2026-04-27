# Bloque 9 — Refactor conversacional con seguridad por capas

Este es el refactor más grande del proyecto. Resuelve **3 problemas estructurales** que tenía la versión anterior:

1. **Bot rígido** — sonaba como formulario, no como asistente
2. **Bugs encadenados** — "Tuve un problema técnico" en pasos críticos
3. **Sin resiliencia** — un fallo del LLM o un click rápido tumbaba todo

## Lo que cambió

### Archivos nuevos

- `src/application/messages.ts` — todas las plantillas con tono cálido dominicano + variantes aleatorias para que el bot no suene robótico

### Archivos refactorizados

- `src/application/session-manager.ts` — `transitionTo` ahora retorna la sesión actualizada, eliminando el bug de "stale context" que causaba el crash en "tipo de pago → confirmar"
- `src/application/orchestrator.ts` — reescrito con 6 capas de seguridad (ver abajo)
- `src/application/llm/client.ts` — retry + circuit breaker + timeout
- `src/application/llm/index.ts` — exporta `LLMUnavailableError`
- `src/channels/telegram/webhook.ts` — mutex por chat + deduplicación + cola

## 6 capas de seguridad

### Capa 1 — Validación de input en cada handler

Cada handler valida que el contexto de la sesión tenga lo que necesita. Si falta un campo crítico (ej: `paciente_telefono` en el momento de confirmar), redirige a un estado válido en vez de crashear.

### Capa 2 — Try/catch granular

Cada handler tiene su propio try/catch. Un fallo en `handleConfirmar` no propaga al request completo. El usuario recibe un mensaje de error específico, no un timeout silencioso.

### Capa 3 — Validación de transiciones FSM

Matriz `TRANSICIONES_VALIDAS` que dice qué estados pueden seguir a cuáles. Si el orchestrator detecta una transición ilegal (ej: `IDLE → CONFIRMANDO` directo), resetea automáticamente y vuelve al menú con mensaje natural.

### Capa 4 — Logging contextual

Cada operación loggea con `tenant_id`, `chat_id`, `estado_actual`. Cuando algo falla en producción, los logs dicen exactamente qué usuario, en qué estado, qué operación.

Ejemplo:
```
[orch] tenant=9881ce90 chat=1234567 estado=ELIGIENDO_HORA entrada type=button_click {"button":"slot:..."}
[orch] tenant=9881ce90 chat=1234567 estado=PIDIENDO_NOMBRE cita creada: CITA-A1B2C3
```

### Capa 5 — Timeouts y retry en LLM

- Timeout duro: 8 segundos por intento
- Hasta 3 intentos con backoff exponencial (1s, 2s, 4s)
- Errores 5xx, 429, timeouts → reintenta automático
- Errores 4xx (auth, modelo no existe) → falla inmediato

### Capa 6 — Circuit breaker para LLM

Si el LLM falla 3 veces seguidas, el "circuit breaker" se abre durante 60s. Durante ese tiempo, todas las llamadas al LLM fallan inmediato sin esperar — el bot funciona con plantillas. Cuando se cierra, vuelve a intentar.

Esto evita que una caída temporal de Anthropic API tumbe el bot completo.

## Mejoras conversacionales

### Tono cálido dominicano

Todos los mensajes usan plantillas variadas. Ejemplos:

**Antes:**
> Vas a agendar con Dr. Hairol Pérez.
> ¿En qué sede prefieres ser atendido?

**Ahora (3 variantes que rotan):**
> Claro que sí, te ayudo a agendar con *Dr. Hairol Pérez* 👨‍⚕️
> ¿En cuál sede te queda mejor?

> ¡Perfecto! Vas a agendar con *Dr. Hairol Pérez* 👨‍⚕️
> ¿En qué sede prefieres ser atendido?

> Listo, agendamos con *Dr. Hairol Pérez* 👨‍⚕️
> ¿Cuál sede te conviene más?

### Detección universal de "cancelar"

Si en cualquier estado escribes "cancela", "olvídalo", "ya no quiero", "menú", "atrás", etc., el bot resetea suavemente y vuelve al menú con mensaje natural ("Listo, dejé de lado lo anterior. ¿En qué te puedo ayudar?"). No tienes que mandar `/start`.

### `/start` a mitad de flujo

Si tocas `/start` mientras estás agendando, ahora pregunta "¿Quieres cancelar lo que ibas haciendo?" antes de resetear. Evita perder el progreso por accidente.

## Resiliencia en Telegram

### Mutex por chat

El webhook ahora serializa los mensajes por usuario:
- Solo 1 update se procesa a la vez por chat
- Si llegan más, se encolan
- Cola máxima: 3 (excedentes se descartan)

Esto resuelve el bug donde clicks rápidos producían respuestas mezcladas.

### Deduplicación de botones

Si tocas el mismo botón 2 veces dentro de 2 segundos, solo procesa la primera. El segundo se descarta silenciosamente (pero responde al callback para que no quede el spinner).

### Timeout de seguridad

Si una operación se cuelga más de 12 segundos, el mutex se libera para que el siguiente mensaje del mismo chat se pueda procesar. Evita deadlocks.

## Bug del "tipo de pago → confirmar"

**Causa raíz:** el orchestrator hacía `transitionTo` que actualizaba la DB, pero después leía `sesion.contexto` (la copia en memoria, antigua). Cuando llegaba a `renderConfirmacion`, leía campos `undefined` y crasheaba en `precio.toLocaleString()`.

**Fix:** `transitionTo` ahora retorna la sesión actualizada. El orchestrator usa esa nueva versión, no la cacheada.

Adicionalmente, `validarContextoConfirmacion()` valida que TODOS los campos requeridos estén presentes antes de renderizar. Si falta alguno, resetea con mensaje claro en vez de crashear.

## Cómo verificar que funciona

1. Sube el zip a GitHub
2. Espera el redeploy en Railway (~2 min)
3. Verifica que `/health` responda OK
4. En Telegram, abre `@citasmed_rd_bot` y prueba:
   - `/start` → debe mostrar menú con tono cálido
   - "Hola, ¿cómo estás?" → bot responde y muestra menú
   - Agendar → sede → servicio → día → hora → nombre → teléfono → tipo de pago → confirmar
   - **Resultado esperado:** mensaje "🎉 ¡Listo! Tu cita está confirmada" con código `CITA-XXXXXX`
5. Verifica en Supabase: `SELECT * FROM citas ORDER BY creado_en DESC LIMIT 1`

## Lo que NO se tocó

- Schema de DB (tablas, RLS, RPCs)
- Repositorios (`src/persistence/repositories/*`)
- Validators (`src/domain/validators/*`)
- Use cases (`src/application/use-cases/*`)
- Adapter de Telegram (`src/channels/telegram/adapter.ts`)
- Tests existentes (19 unit tests siguen pasando)

## Próximos pasos sugeridos

Una vez confirmado que funciona en producción:

1. **Bloque 4 retomar:** Sentry + logger estructurado JSON
2. **Bloque 10:** API REST para tu dashboard actual
3. **Canal WhatsApp Cloud API** (canal de producción real)
4. **Recordatorios automáticos** (24h y 1h antes de la cita)
