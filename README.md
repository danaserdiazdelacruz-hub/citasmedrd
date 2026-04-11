# CitasMed API — TypeScript / Node.js

API REST para el sistema de citas médicas. Migración del PHP original.

---

## Estructura del proyecto

```
citasmed/
├── src/
│   ├── index.ts              ← servidor principal (aquí arranca todo)
│   ├── lib/
│   │   ├── env.ts            ← carga y valida variables de entorno
│   │   ├── supabase.ts       ← cliente HTTP para Supabase
│   │   └── dates.ts          ← helpers de fechas y validaciones
│   ├── middleware/
│   │   ├── auth.ts           ← autenticación por API key
│   │   └── errors.ts         ← manejo global de errores
│   └── routes/
│       ├── test.ts           ← GET  /api/test
│       ├── servicios.ts      ← GET  /api/servicios
│       ├── slots.ts          ← GET  /api/slots
│       ├── agendar.ts        ← POST /api/agendar
│       ├── cancelar.ts       ← POST /api/cancelar
│       ├── reagendar.ts      ← POST /api/reagendar
│       ├── marcar-atendido.ts← POST /api/marcar-atendido
│       ├── citas-dia.ts      ← GET  /api/citas-dia
│       ├── citas-rango.ts    ← GET  /api/citas-rango
│       ├── proximas.ts       ← GET  /api/proximas
│       ├── bloquear-dia.ts   ← POST/DELETE /api/bloquear-dia
│       └── dias-bloqueados-list.ts ← GET /api/dias-bloqueados
├── tests/
│   ├── dates.test.ts         ← tests de fechas y validaciones
│   └── routes.test.ts        ← tests de lógica de rutas
├── .env.example              ← plantilla de variables de entorno
├── package.json
└── tsconfig.json
```

---

## Cómo correr en local (primera vez)

**Requisitos:** Node.js 20+ instalado.

```bash
# 1. Instalar dependencias
npm install

# 2. Crear tu archivo .env
cp .env.example .env
# Edita .env con tus valores reales de Supabase

# 3. Correr en modo desarrollo (recarga automática al editar)
npm run dev
```

Verás:
```
✅ CitasMed API corriendo en http://localhost:3000
   Supabase: https://xxxx.supabase.co
   Timezone: America/Santo_Domingo
```

Prueba que funciona:
```bash
curl http://localhost:3000/api/test -H "X-API-Key: tu_api_secret"
```

---

## Correr los tests

```bash
npm test
```

Los tests NO necesitan internet ni Supabase. Verifican validaciones y lógica interna.

---

## Desplegar en Railway

1. Crea cuenta en [railway.app](https://railway.app)
2. Clic en **New Project → Deploy from GitHub repo**
3. Conecta este repositorio
4. En **Variables** agrega:
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_KEY=tu_service_role_key
   API_SECRET=una_clave_larga_y_aleatoria
   TIMEZONE=America/Santo_Domingo
   PORT=3000
   ```
5. Railway detecta el `package.json` y despliega automáticamente.
6. Tu URL quedará algo como: `https://citasmed-api.up.railway.app`

---

## Endpoints disponibles

Todos requieren el header: `X-API-Key: tu_api_secret`

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/test` | Verificar que la API funciona |
| GET | `/api/servicios?doctor_clinica_id=UUID` | Tipos de consulta |
| GET | `/api/slots?doctor_clinica_id=UUID&fecha=YYYY-MM-DD&servicio_id=UUID` | Horarios disponibles |
| POST | `/api/agendar` | Crear una cita |
| POST | `/api/cancelar` | Cancelar por cita_id o código |
| POST | `/api/reagendar` | Mover cita a otro horario |
| POST | `/api/marcar-atendido` | Marcar cita como completada |
| GET | `/api/citas-dia?dc_id=UUID&fecha=YYYY-MM-DD` | Citas de un día |
| GET | `/api/citas-rango?dc_id=UUID&desde=YYYY-MM-DD&hasta=YYYY-MM-DD` | Citas de un rango |
| GET | `/api/proximas?dc_id=UUID&dias=7` | Próximas N días (reemplaza 8 llamadas) |
| POST | `/api/bloquear-dia` | Bloquear un día completo |
| DELETE | `/api/bloquear-dia` | Desbloquear un día |
| GET | `/api/dias-bloqueados?dc_id=UUID` | Listar días bloqueados |

---

## Cambios respecto al PHP original

- **Sin cambios en la lógica de negocio** — mismas funciones Supabase, mismo comportamiento
- Los nombres de rutas cambian de `.php` a sin extensión: `/api/agendar.php` → `/api/agendar`
- Validación con Zod: errores más claros y en español
- Un solo punto de entrada (`index.ts`) en vez de archivos sueltos
- Los errores nunca dejan al servidor sin respuesta (express-async-errors)
- Tests automáticos incluidos
