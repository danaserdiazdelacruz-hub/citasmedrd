# 🏥 CitasMed v3 — Versión consolidada

> Esta es la versión definitiva con todos los bloques aplicados.
> Listo para `npm install && npm run build && npm start`.

---

## 📦 Qué incluye este zip

Todo el código actualizado con los bloques 10, 10.1, 11, 12, y 14 ya integrados.

### Bloques aplicados

| # | Nombre | Resumen | Migración SQL |
|---|--------|---------|---------------|
| 10 | Funcional | Multi-tenant correcto, timezone, slot re-validation, idempotencia, atomicidad | `migrations/005_sesion_atomic.sql` (recomendada) |
| 10.1 | Conversacional | El LLM responde texto natural, saludo enriquecido, anti cita doble | — |
| 11 | María Salud | Identidad estandarizada de la asistente, configurable por tenant | — |
| 12 | Búsqueda por nombre | El LLM detecta nombres y salta directo a sede | — |
| 14 | Historial al LLM | El bot recuerda lo conversado dentro de la sesión | — |

---

## 🚀 Cómo deployar

### 1. Descomprimir

```bash
unzip citasmedrd-v3-completo.zip
cd citasmedrd-v3
```

### 2. Aplicar migración SQL (recomendado)

En **Supabase → SQL Editor**, pega y corre:

```
migrations/005_sesion_atomic.sql
```

Esto crea funciones que evitan race conditions. Es **idempotente** (seguro re-correr).

> Si NO aplicas la migración, el bot sigue funcionando con un fallback "legacy" que puede perder datos si dos clicks llegan simultáneos.

### 3. Variables de entorno

Copia `.env.example` a `.env` y completa:

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
SUPABASE_URL=https://...supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_ANON_KEY=...
TELEGRAM_BOT_TOKEN=...
CREDENTIALS_ENCRYPTION_KEY=<64 chars hex>
PORT=8080
```

### 4. Configurar webhook de Telegram

URL nueva: `/webhook/telegram/<canal_conectado_id>`

El `canal_conectado_id` es el `id` de la fila en la tabla `canales_conectados` de Supabase.

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://TU-URL/webhook/telegram/<canal_conectado_id>
```

Telegram debe responder `{"ok":true}`.

### 5. Build y deploy

```bash
npm install
npm run build
npm start
```

En Railway: push a la rama conectada y deploya automático.

---

## 🩺 Identidad de la asistente: María Salud

Default global: **"María Salud"**.

Si algún consultorio quiere otro nombre, en Supabase:

```
Tabla: tenants
Columna: configuracion (jsonb)
Setear: {"asistente_nombre": "Otro Nombre"}
```

Se lee en cada turn — no requiere reinicio.

---

## 🔍 Búsqueda inteligente de profesional

El paciente puede decir cosas naturales como:

- *"quiero cita con Hairol Pérez"* → va directo a sede
- *"necesito ver a la doctora María"* → va directo a sede
- *"cita con Pérez"* (si hay 2 Pérez) → muestra botones para elegir
- *"ver al Dr. Mendoza"* (no existe) → "no lo encontré" + lista completa

Funciona solo en estado `IDLE` y solo cuando la intención es agendar.
La búsqueda hace `ILIKE` sobre `nombre` y `apellido`, normalizando acentos para el ranking en JS.

---

## 🧠 Memoria conversacional

El LLM ahora recibe los últimos 10 turnos sanitizados. Si dices "ese servicio" o "el segundo", el bot entiende la referencia.

La sesión expira a las 24h sin actividad.

---

## ✅ Verificación

```bash
npm install
npm run build       # ✓ compila limpio
npm test            # ✓ 47/47 tests pasan
```

Tests incluidos:
- 19 validators (teléfono RD, nombre, email, cédula)
- 17 datetime (timezone-aware fechas/horas)
- 11 historial (sanitización para LLM)

---

## 📂 Estructura del proyecto

```
citasmedrd-v3/
├── BLOQUE_10_FUNCIONAL.md         — detalles del Bloque 10
├── BLOQUE_10_1_CONVERSACIONAL.md  — detalles del Bloque 10.1
├── README.md                       — este archivo
├── migrations/
│   └── 005_sesion_atomic.sql       — migración SQL (Bloque 10)
├── src/
│   ├── application/                — orquestador, LLM, casos de uso
│   ├── channels/                   — adaptador Telegram
│   ├── config/                     — env vars
│   ├── domain/                     — validadores, datetime, historial
│   └── persistence/                — repositorios Supabase
└── tests/
    └── unit/
        ├── validators.test.ts
        ├── datetime.test.ts
        └── historial-llm.test.ts
```

---

## 🔮 Lo que sigue (no incluido aquí)

- **Bloque 12.B** — Búsqueda por extensión telefónica (requiere migración SQL pequeña)
- **Bloque 13** — Memoria larga del paciente >24h (requiere tabla nueva)
- **Bloque 15** — Seguridad y cleanup (validación webhook, cifrado, etc.)

Cuando estés listo para uno de esos, avísame.

---

## ⚠️ Cosas a tener en cuenta

1. **El `update_id` de Telegram tiene cache LRU en memoria** (10 min). Si escalas a 2+ instancias horizontalmente, hay que mover esto a Redis. Mientras corra 1 instancia (Railway por defecto), está bien.

2. **La sesión vive 24h sin actividad.** Si pasas 24h sin escribir, el bot olvida tu teléfono y nombre.

3. **El paciente se identifica por chat_id de Telegram.** Si abre desde otra cuenta, es un desconocido (aunque tenga cita en la DB con su teléfono).

4. **La migración 005 es idempotente.** Puedes correrla cuantas veces quieras sin riesgo.

5. **Los logs muestran números de teléfono en cleartext.** Esto se limpia en el Bloque 15 (PII / HIPAA).
