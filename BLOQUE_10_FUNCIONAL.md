# 🔧 Bloque 10 — Refactor funcional (v3)

> Esta versión NO toca seguridad ni cleanup.  
> Solo arregla cosas que rompían el funcionamiento real con múltiples consultorios.

---

## TL;DR — qué cambió y por qué importa

| # | Problema en v2 | Solución en v3 |
|---|----------------|----------------|
| 1 | Webhook agarraba "el primer canal activo" → si dos consultorios tenían bots, todos los mensajes iban al primero | Webhook URL ahora incluye el `canal_conectado_id`. Cada bot apunta a su propia URL. |
| 2 | Solo soportaba 1 profesional (`profesionales[0]`) | Si hay 2+ profesionales, el bot pregunta al paciente con cuál quiere agendar |
| 3 | El system prompt tenía servicios y sedes hardcoded de oncología | El prompt se construye con datos reales del tenant desde la DB |
| 4 | Fechas calculadas en UTC del servidor, no en hora dominicana | Todas las fechas usan la `timezone` del tenant |
| 5 | El paciente podía elegir un slot, demorarse, y al confirmar ya no estaba libre — daba error feo | Re-validación del slot antes de crear la cita. Si está tomado, ofrece otros |
| 6 | Telegram reintentaba updates → se creaban citas duplicadas | Idempotencia por `update_id` (cache LRU 10min) |
| 7 | Race conditions: dos clicks simultáneos pisaban el contexto de la sesión | Operaciones atómicas en Postgres (jsonb concat con FOR UPDATE) |

---

## 🚨 Acciones requeridas para que funcione

### 1. Aplicar migración SQL (importante)

En el SQL Editor de Supabase, pega y corre el contenido de:

```
migrations/005_sesion_atomic.sql
```

Esto crea 3 funciones (`fn_sesion_update`, `fn_sesion_reset`, `fn_sesion_append_historial`) que el backend usa para mergear contexto de sesión sin race conditions. Es **idempotente** — seguro re-correrlo.

> Si NO aplicas la migración, el bot sigue funcionando, pero usa el path "legacy" con read-modify-write y puede perder datos si dos clicks llegan simultáneos. Lo verás en los logs como un WARN.

### 2. Re-configurar el webhook de cada bot

La URL del webhook **cambió**. Antes era:

```
https://tu-dominio.com/webhook/telegram
```

Ahora es:

```
https://tu-dominio.com/webhook/telegram/<canal_conectado_id>
```

Donde `<canal_conectado_id>` es el `id` (UUID) de la fila en la tabla `canales_conectados` de Supabase.

**Cómo encontrar tu canal_conectado_id:**

1. Abre Supabase → Table Editor → `canales_conectados`
2. Busca la fila de tu bot (filtra por `tipo = 'telegram'` y `estado = 'activo'`)
3. Copia el valor de la columna `id`

**Cómo configurar el webhook en Telegram:**

Reemplaza `<TOKEN>` con el token de tu bot y `<URL>` con la URL completa, y corre desde tu navegador o `curl`:

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://tu-dominio.com/webhook/telegram/<canal_conectado_id>
```

Telegram te responderá con `{"ok":true,...}` si quedó bien.

> Si tienes 3 consultorios con 3 bots, configura los 3 webhooks — cada uno apuntando a su propio `canal_conectado_id`.

---

## 📂 Archivos cambiados

### Nuevos

- `src/domain/datetime.ts` — utilidades puras de fecha/hora con timezone (sin libs externas, usa `Intl.DateTimeFormat`)
- `migrations/005_sesion_atomic.sql` — funciones SQL para merge atómico
- `tests/unit/datetime.test.ts` — 17 tests del módulo de fechas

### Modificados

- `src/index.ts` — extrae `canalId` del path
- `src/channels/telegram/webhook.ts` — recibe `canalId`, idempotencia por `update_id`
- `src/persistence/repositories/tenants.repo.ts` — agrega `findCanalById`
- `src/persistence/repositories/sesiones.repo.ts` — usa RPCs atómicos con fallback legacy
- `src/application/session-manager.ts` — adapta a nueva firma del repo
- `src/application/orchestrator.ts` — multi-profesional, timezone-aware, slot re-validation, prompt dinámico
- `src/application/llm/prompt-builder.ts` — recibe datos reales del tenant
- `src/application/messages.ts` — agrega `eligiendoProfesional()`

---

## 🧪 Verificación

```bash
npm install
npm run build       # ✓ compila sin errores
npm test            # ✓ 36/36 tests pasan (19 validators + 17 datetime)
```

---

## 🔍 Detalle por cambio

### 1. Resolución de canal por ID (multi-tenant correcto)

**Antes** (v2):

```typescript
// webhook.ts
const canal = await tenantsRepo.resolveCanalTelegramActivo();
// Devolvía el PRIMER canal activo. Bug catastrófico en multi-tenant.
```

**Ahora** (v3):

```typescript
// index.ts
const match = url.match(/^\/webhook\/telegram\/([^/?#]+)/);
const canalId = match?.[1];
handleTelegramUpdate(canalId, update);

// webhook.ts
const r = await tenantsRepo.findCanalById(canalId);
// Resuelve el canal específico. Multi-tenant correcto.
```

### 2. Multi-profesional

El FSM ya tenía el estado `ELIGIENDO_PROFESIONAL` definido — pero nunca se usaba. v3 lo conecta:

```typescript
async function iniciarFlujoAgendar(...) {
  const profesionales = await profesionalesRepo.listarActivos(tenantId);
  if (profesionales.length === 0) { return [{ kind: "text", text: "No hay profesionales..." }]; }
  if (profesionales.length === 1) {
    return await mostrarSedesParaProfesional(...);   // saltamos paso, igual que antes
  }
  // 2+ profesionales: preguntar al paciente
  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_PROFESIONAL", {});
  return [{ kind: "buttons", text: M.eligiendoProfesional(), buttons: [...] }];
}
```

Y se agregó el handler `handleProfesionalButton` y el case `profesional` al switch de botones.

### 3. System prompt dinámico

**Antes** (v2 — hardcoded):

```typescript
const systemPrompt = buildSystemPrompt({
  serviciosTexto: "Consulta de Ginecología y Oncología, Citología, Colposcopia...",
  sedesTexto: "3 sedes: Santo Domingo (Centro Médico María Dolores)...",
  ...
});
```

**Ahora** (v3 — desde DB):

```typescript
const profesionales = await profesionalesRepo.listarActivos(tenantId);
const sedes = await profesionalesRepo.listarSedesPorProfesional(...);
const servicios = await profesionalesRepo.listarServiciosPublicos(...);

const systemPrompt = buildSystemPrompt({
  nombreClinica: tenant.nombre_comercial,
  tipoEntidad: tenant.tipo_entidad,
  profesionales, sedes, servicios,
  ...
});
```

Resultado: cuando conectes un dentista o un psicólogo, su bot habla de **sus** servicios — no de oncología.

### 4. Timezone-aware

**Antes** (v2):

```typescript
const hoy = new Date();          // hora del servidor (Railway = UTC)
hoy.setDate(hoy.getDate() + 1);  // "mañana" en UTC, no en RD
```

**Ahora** (v3):

```typescript
const tz = tenant.timezone || "America/Santo_Domingo";
proximosDiasHabiles(5, tz);   // "mañana" según el calendario del tenant
formatHoraCorta(s.iniciaEn, tz);  // "8:00 AM" en hora local
```

Esto importa porque a las 22:00 RD (02:00 UTC), el servidor pensaba que ya era el día siguiente.

### 5. Re-validación de slot

**Antes** (v2): el paciente elegía las 8am, demoraba mientras pensaba si confirmar, y al darle "Sí confirmar" la `fn_agendar_cita_v2` rechazaba con "slot tomado". El bot mostraba error genérico y el paciente quedaba botado.

**Ahora** (v3): antes de llamar a `fn_agendar_cita_v2`, re-llamamos `listarHorariosLibres` y verificamos que el slot siga libre. Si no:

> "Uy, ese horario lo tomaron mientras decidías 😕 Estos están libres todavía:" + botones con horarios actualizados

### 6. Idempotencia de update_id

```typescript
// Cache LRU en memoria, key=`${canalId}:${updateId}`, TTL 10min
if (yaProcesado(canalId, updateId)) {
  console.log("update duplicado, descartando");
  return;
}
```

Telegram puede reintentar updates si nuestra respuesta tarda más de 5s o si su red hipa. Sin esto, una misma cita se podía crear dos veces.

> ⚠️ **Limitación**: el cache es por instancia (in-memory). Cuando escalemos a 2+ pods (horizontal), hace falta moverlo a Redis. Mientras corra 1 sola instancia (Railway por defecto), está bien.

### 7. Race conditions atómicas

**Antes** (v2):

```typescript
// updateEstado leía contexto, mezclaba en JS, guardaba todo
const { data } = await db.from("...").select("contexto").eq("id", id).single();
const merged = { ...data.contexto, ...nuevosPampos };
await db.from("...").update({ contexto: merged }).eq("id", id);
// 👆 Si dos clicks llegan a la vez, uno pisa el otro.
```

**Ahora** (v3):

```typescript
await rpc("fn_sesion_update", { p_sesion_id, p_estado, p_contexto_merge });
// Internamente: UPDATE ... SET contexto = contexto || p_contexto_merge
// Una sola operación SQL, atómica.
```

Mismo patrón para `fn_sesion_reset` y `fn_sesion_append_historial` (esta última usa `FOR UPDATE` para serializar appends concurrentes).

---

## ✅ Lo que NO se tocó (para el siguiente bloque)

Todo esto sigue como estaba en v2 y se queda para "Bloque 11 — Seguridad y Cleanup":

- Validación del header `X-Telegram-Bot-Api-Secret-Token`
- Límite de tamaño del body
- Logging de números de teléfono en cleartext (PII)
- Migrar de `node:http` a `fastify` (las deps están instaladas pero no usadas)
- Cifrar `credenciales_cifradas` (la columna existe pero `CREDENTIALS_ENCRYPTION_KEY` nunca se usa)
- Mover mutex/circuit-breaker a Redis para escalamiento horizontal
- Logging estructurado con `pino` en vez de `console.log`
- Limpieza de `TipoPago: "seguro" | "mixto"` no implementados

---

## 💡 Cosas a confirmar manualmente después de deploy

1. ✅ El `setWebhook` del bot devolvió `{"ok":true}`
2. ✅ Mandar `/start` al bot — debe saludar con el nombre real del consultorio (no "CitasMed" genérico)
3. ✅ Si el tenant tiene 2+ profesionales, debe aparecer el paso de elegir profesional
4. ✅ Las fechas de los botones deben ser días hábiles a partir de **mañana en hora dominicana** (no en UTC)
5. ✅ Crear una cita debe funcionar end-to-end y mostrar el `CITA-XXXXXX` real
6. ✅ Mandar `/start` dos veces seguidas rápido — el segundo debe ignorarse (idempotencia)
