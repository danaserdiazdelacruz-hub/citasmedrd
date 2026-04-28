# 🗣️ Bloque 10.1 — Bot menos torpe, más conversacional

> Hotfix sobre v3 funcional. Atacando el problema: "el bot habla como IVR de los 2010".

---

## Síntoma del problema (en logs reales del deploy)

```
estado=IDLE entrada type=text {"text":"como estas"}
[tg:69994470] procesado OK (1 mensajes)   ← respondió MENÚ

estado=IDLE entrada type=text {"text":"????"}
[tg:69994471] procesado OK (1 mensajes)   ← respondió MENÚ otra vez
```

El usuario escribió "como estas" y "????" (frustrado). El bot ignoró ambos textos y mostró el menú robóticamente. **El LLM SÍ se llamaba, pero su respuesta de texto se tiraba a la basura.**

Además, después de crear `CITA-9A0419`, el usuario podría darle a "Agendar otra cita" sin que el bot le advirtiera "ojo, ya tienes una cita activa".

---

## Qué cambió en v3.1

### 1. El LLM ahora CONVERSA, no solo clasifica

**Antes** (v3.0): el orquestador llamaba al LLM, miraba si vino `detectar_intencion`, y si no → menú genérico. El campo `text` de la respuesta nunca se usaba.

**Ahora** (v3.1):
- Si el LLM respondió en texto natural ("¡Hola! Todo bien, ¿en qué te ayudo?"), ese texto se envía al usuario.
- Después del texto del LLM, se agrega el menú compacto para que pueda elegir botón si quiere.
- Solo si el LLM detectó intención clara (`agendar`, `consultar`, `cancelar` con confianza ≥ 0.7), se salta directo al flujo correspondiente.

### 2. System prompt rediseñado

El prompt anterior obligaba a usar `detectar_intencion` siempre. El nuevo enseña al modelo:
- Cuándo conversar en texto (saludos, small talk, dudas generales)
- Cuándo invocar `detectar_intencion` (intención clara e inequívoca)
- Cómo invitar al menú después de responder

Incluye 5 ejemplos in-context de cada caso.

### 3. Si te conoce, te saluda diferente

El prompt ahora recibe el **nombre del paciente** (si está en memoria de sesión) y la **cita activa** que tenga. Resultado:

> "Hola Erika 👋 Veo que ya tienes cita programada el lunes 28 a las 8:20 AM. ¿En qué te ayudo?"

en lugar de:

> "Bienvenido a CitasMed. ¿En qué te puedo ayudar?"

### 4. Menú principal contextual

Cuando el paciente vuelve a `/start` y ya tiene cita activa, el menú cambia:

**Antes** (v3.0):
```
📅 Agendar una cita
🔍 Ver mis citas
❌ Cancelar una cita
```

**Ahora** (v3.1, paciente con cita activa):
```
👋 ¡Hola de nuevo! Te tengo registrado con cita en *Centro Médico…*:
📅 Consulta General
🕒 lunes 28 de abril, 8:20 AM

¿En qué te ayudo?

🔍 Ver mi cita
❌ Cancelar mi cita
📅 Agendar otra cita
```

### 5. Bloqueo de doble agenda accidental

Cuando el paciente clickea "Agendar una cita" y ya tiene una activa, el bot pregunta antes de iniciar el flujo:

> "Antes de agendar otra: ya tienes una cita activa.
> 📅 *Consulta General*
> 🕒 lunes 28 de abril, 8:20 AM
> 🎫 CITA-9A0419
>
> ¿Quieres reagendar esa o agendar una adicional?"
>
> [✅ Esa está bien] [❌ Cancelar esa] [➕ Agendar otra adicional]

Si elige "Agendar otra adicional", el bot procede con el flujo (algunos casos legítimos: revisión + procedimiento, dos servicios distintos, etc).

---

## Archivos cambiados

- `src/application/llm/prompt-builder.ts` — prompt rediseñado, recibe `pacienteNombre` + `citaActiva`
- `src/application/orchestrator.ts`:
  - `handleIdleConLLM` ahora usa `llmRes.text` y enriquece el prompt con cita activa del paciente
  - `iniciarFlujoAgendar` chequea cita activa antes de empezar (con flag `forzarNueva` para saltarse)
  - `handleIntentButton` maneja nuevo botón `intent:agendar_otra`
  - `menuPrincipal` muestra saludo + opciones diferentes si hay cita activa
- `src/application/messages.ts` — nuevos helpers: `saludoConCitaPendiente`, `yaTienesCitaActiva`, `opcionesMenuConCitaPendiente`, `opcionesYaTieneCita`
- `tsconfig.json` — agrega `"ignoreDeprecations": "5.0"` para que TypeScript 5.9 no rompa el build

---

## Prueba antes y después

### Caso A: paciente nuevo dice "como estas"

**Antes:**
```
Usuario: "como estas"
Bot: 👋 ¡Hola! Bienvenido a CitasMed. ¿En qué te puedo ayudar? [menú]
```
(ignora la pregunta, suena robot)

**Ahora:**
```
Usuario: "como estas"
Bot: ¡Bien, gracias por preguntar! 😊 ¿Y tú cómo estás? ¿En qué te puedo ayudar?
[menú compacto]
```

### Caso B: paciente con cita activa vuelve a `/start`

**Antes:**
```
Bot: 👋 ¡Hola! Bienvenido a Centro Médico. ¿En qué te puedo ayudar?
[Agendar | Ver mis citas | Cancelar]
```
(parece que el bot olvidó al paciente)

**Ahora:**
```
Bot: 👋 ¡Hola de nuevo! Te tengo registrado con cita en *Centro Médico*:
📅 Consulta General
🕒 lunes 28 de abril, 8:20 AM
¿En qué te ayudo?
[Ver mi cita | Cancelar mi cita | Agendar otra cita]
```

### Caso C: paciente con cita activa clickea "Agendar"

**Antes:** lo dejaba agendar otra cita sin advertir → DOBLE CITA accidental.

**Ahora:** advierte que ya tiene una y le ofrece reagendar / cancelar / agregar adicional.

---

## Verificación

```bash
npm install
npm run build       # ✓ compila limpio
npm test            # ✓ 36/36 tests pasan
```

---

## Lo que NO cambió

- Migración SQL (`005_sesion_atomic.sql`) sigue siendo opcional pero recomendada
- URL del webhook (`/webhook/telegram/<canal_conectado_id>`) sin cambios
- Toda la seguridad/cleanup queda para el siguiente bloque

---

## Cosas a probar después de deploy

1. Desde un chat fresco: escribir "hola" → debería conversar, no tirar menú frío
2. Escribir "que servicios tienen?" → debería listar los reales del tenant (no oncología)
3. Escribir "quiero una cita" → debería saltar directo al flujo
4. Después de crear una cita, hacer `/start` → saludo debe mencionar la cita
5. Después de crear una cita, click en "Agendar otra cita" → debe preguntar si quiere reagendar o adicional
