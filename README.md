# CitasMed Backend

Plataforma SaaS multi-tenant para profesionales de la salud.

## Arranque local

### 1. Prerequisitos

- Node.js 22 LTS o superior
- Cuenta Supabase con las migraciones 001-004b aplicadas
- API key de Anthropic
- Bot de Telegram (para testing) creado con @BotFather

### 2. Instalar

```bash
git clone <repo>
cd citasmed-backend
npm install
```

### 3. Configurar variables

```bash
cp .env.example .env
# Edita .env con tus credenciales reales
```

Genera la clave de cifrado:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Pégala en `CREDENTIALS_ENCRYPTION_KEY`.

### 4. Correr en desarrollo

```bash
npm run dev
```

El servidor arranca en `http://localhost:3000`.

### 5. Verificar que compila

```bash
npm run typecheck
npm run lint
```

## Estructura del proyecto

```
src/
├── channels/        # Adaptadores por canal (WA, IG, FB, Web, TG)
├── application/     # Casos de uso + orchestrator + LLM
├── domain/          # Reglas puras, sin IO
├── persistence/     # Repositorios (únicos que tocan DB)
├── api/             # REST para dashboard
├── infrastructure/  # Observabilidad, queue, crypto
└── config/          # env validado
```

### Fronteras entre capas

El linter (`eslint-plugin-boundaries`) impone:

- `channels` → puede usar `application`, `domain`, `config`, `infrastructure`
- `application` → puede usar `domain`, `persistence`, `config`, `infrastructure`
- `domain` → solo a sí misma (reglas puras)
- `persistence` → solo a sí misma + infra
- `api` → como channels

**Si un archivo cruza una frontera prohibida, `npm run lint` falla.**

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | Arranca con recarga automática |
| `npm run build` | Compila a `dist/` |
| `npm start` | Corre el build de producción |
| `npm run typecheck` | Solo verifica tipos |
| `npm run lint` | ESLint + fronteras arquitectónicas |
| `npm test` | Vitest suite |

## Deploy a Railway

(instrucciones vendrán al completar el bloque 10)
