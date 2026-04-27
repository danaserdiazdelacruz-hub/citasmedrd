# CitasMed Backend v2

Plataforma SaaS multi-tenant para profesionales de la salud.

---

## 🚀 Instalación rápida (sin terminal)

Flujo: **descomprimir zip → subir a GitHub → conectar a Railway → configurar variables**.

### 1. Descomprimir el zip

Descomprime en una carpeta. Debe quedar esta estructura exacta:

```
citasmedrd/
├── .env.example
├── .gitignore
├── .nvmrc
├── README.md
├── eslint.config.js
├── package.json
├── railway.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── config/
│   │   └── env.ts
│   ├── persistence/
│   │   └── db.ts
│   └── domain/
│       ├── errors.ts
│       └── validators/
│           ├── phone.ts
│           ├── name.ts
│           ├── document-id.ts
│           ├── email.ts
│           └── index.ts
└── tests/
    └── unit/
        └── validators.test.ts
```

### 2. Subir a GitHub

- Borra todo lo que tenías en el repo anterior
- Sube todos estos archivos respetando la estructura de carpetas
- Commit: `feat: backend v2 — bloques 1 y 2 (config + domain)`

### 3. Conectar Railway

Railway detecta el `package.json` y construye automáticamente con `npm run build`.
El `railway.json` ya tiene el healthcheck configurado en `/health`.

### 4. Configurar variables en Railway

En Railway → tu servicio → pestaña **Variables** → agrega:

```
NODE_ENV=production
LOG_LEVEL=info

SUPABASE_URL=https://tu-proyecto-nuevo.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
SUPABASE_ANON_KEY=eyJhbGc...

ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001

TELEGRAM_BOT_TOKEN=123456789:AAAA...

CREDENTIALS_ENCRYPTION_KEY=<generar, ver abajo>

CORS_ALLOWED_ORIGINS=https://dashboard.citasmed.rd
```

**Importante:** `CREDENTIALS_ENCRYPTION_KEY` debe ser 64 caracteres hexadecimales.

Para generarla usa cualquiera:

- **Online:** https://generate-random.org/encryption-key-generator → elige 256-bit en Hex
- **Mac/Linux terminal:** `openssl rand -hex 32`
- **Node:** `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Pega el resultado de 64 chars en Railway.

### 5. Deploy

Railway hace deploy automático en cada push. El primer build tarda 2-3 minutos.

### 6. Verificar

Abre `https://TU-URL-RAILWAY/health` en el navegador. Debe responder:

```json
{
  "status": "ok",
  "env": "production",
  "timestamp": "2026-04-24T..."
}
```

Si ves eso, los Bloques 1 y 2 están funcionando correctamente.

Si ves error, revisa los logs en Railway → Deployments → último deploy → View Logs.
Los errores de variables de entorno aparecen con `❌ Variables de entorno inválidas:` — ahí te dice exactamente qué variable falta.

### 7. Configurar webhook de Telegram (importante)

Cada bot tiene su propio webhook con la URL:

```
https://TU-URL-RAILWAY/webhook/telegram/<canal_conectado_id>
```

El `<canal_conectado_id>` lo encuentras en Supabase → Table Editor → `canales_conectados` → columna `id`.

Para registrar el webhook abre en el navegador (reemplazando `<TOKEN>` y `<URL>`):

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<URL>
```

Telegram debe responder `{"ok":true}`.

> Si tienes varios consultorios/bots, configura cada uno apuntando a su propio `canal_conectado_id`. Cada bot solo verá los mensajes de su consultorio.

### 8. Aplicar migración SQL de sesiones atómicas

Abre Supabase → SQL Editor → pega el contenido de `migrations/005_sesion_atomic.sql` → Run.

Esto crea funciones que evitan race conditions en el contexto de las sesiones. Es idempotente (seguro re-correrlo).

---

## 📂 Estructura del proyecto

```
src/
├── channels/        (Bloque 8) Adaptadores WhatsApp, IG, FB, Web, Telegram
├── application/     (Bloques 5-7) Casos de uso + orchestrator + LLM
├── domain/          ✅ Reglas puras, sin IO (este bloque)
├── persistence/     (Bloque 3) Repositorios (únicos que tocan DB)
├── api/             (Bloque 9) REST para dashboard
├── infrastructure/  (Bloque 4) Observabilidad, queue, crypto
└── config/          ✅ env validado (este bloque)
```

### Fronteras entre capas (impuestas por linter)

- `channels` → puede usar `application`, `domain`, `config`, `infrastructure`
- `application` → puede usar `domain`, `persistence`, `config`, `infrastructure`
- `domain` → solo a sí misma (reglas puras, sin IO)
- `persistence` → solo a sí misma + infra
- `api` → como `channels`

Si alguien cruza una frontera prohibida, `npm run lint` falla.

---

## 🧪 Scripts disponibles

| Comando | Qué hace |
|---|---|
| `npm run dev` | Arranca con recarga automática |
| `npm run build` | Compila a `dist/` |
| `npm start` | Corre el build (Railway lo usa) |
| `npm run typecheck` | Verifica tipos |
| `npm run lint` | ESLint + fronteras |
| `npm test` | Vitest (tests unitarios) |

---

## ✅ Bloques 1 + 2 (ya implementado)

- Configuración validada con Zod
- Cliente Supabase con service_role
- Validador de teléfono dominicano (E.164)
- Validador de nombre con anti-basura
- Validador de cédula dominicana con Luhn
- Validador de email
- Catálogo oficial de 17 ErrorCodes sincronizado con la DB
- Clase `DomainError` tipada
- Tests unitarios
- Healthcheck HTTP
- Configuración Railway

## ⏳ Bloques 3-10 (viene después)

- Bloque 3: Repositorios (citas, pacientes, profesionales, sesiones, tenants)
- Bloque 4: Observabilidad (Sentry + pino logger estructurado)
- Bloque 5: Casos de uso (agendar, cancelar, reagendar, listar_horarios)
- Bloque 6: Cliente Claude con tool use
- Bloque 7: Session manager + orchestrator FSM
- Bloque 8: Canal Telegram (testing) + WhatsApp Cloud (producción)
- Bloque 9: API REST para dashboard
- Bloque 10: Deploy final + runbook operativo
