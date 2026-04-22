# 🔐 CitasMed v4 — Seguridad real + PWA

Esta versión cierra los **4 problemas críticos** antes de dar acceso a doctores reales:

1. ✅ API Key ya no está en el frontend
2. ✅ Login real con JWT (no hardcoded)
3. ✅ Doctor y sedes vienen del backend (no hardcoded)
4. ✅ PWA instalable como app nativa

---

## 📦 Archivos nuevos/modificados

### Backend (Railway)
```
src/
├── index.ts                          [MODIFICADO: registra login + bootstrap]
├── lib/
│   └── jwt.ts                        [NUEVO: firma/verifica JWT HS256]
├── middleware/
│   └── auth.ts                       [MODIFICADO: JWT + API Key dual]
├── routes/
│   ├── login.ts                      [NUEVO: POST /api/login + GET /api/login/me]
│   └── bootstrap.ts                  [NUEVO: GET /api/bootstrap]
public/
├── manifest.json                     [NUEVO: PWA manifest]
├── sw.js                             [NUEVO: Service Worker]
├── icon-192.png                      [NUEVO: ícono PWA]
├── icon-512.png                      [NUEVO: ícono PWA]
└── icon.svg                          [NUEVO: ícono vectorial fuente]
```

### Dashboard
```
citasmedprocesomjora.html             [MODIFICADO: login real, JWT, bootstrap, PWA]
```

---

## 🔧 Configuración en Railway — paso a paso

### Paso 1 — Generar el hash de la contraseña del doctor

En tu terminal local:

**Linux/Mac/WSL:**
```bash
echo -n "TuContraseñaAqui" | sha256sum
```

**Windows (PowerShell):**
```powershell
$s = [System.Text.Encoding]::UTF8.GetBytes("TuContraseñaAqui")
[BitConverter]::ToString((New-Object System.Security.Cryptography.SHA256Managed).ComputeHash($s)).Replace("-","").ToLower()
```

Te devolverá algo como:
```
a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3
```

Copia ese valor.

### Paso 2 — Generar JWT_SECRET aleatorio

```bash
# Linux/Mac/WSL
openssl rand -base64 48

# Si no tienes openssl:
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

Ejemplo resultado:
```
Jx8K9mNpQr2LvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUv
```

### Paso 3 — Añadir variables de entorno en Railway

Railway → tu proyecto → Variables → añadir estas 5:

| Variable | Valor | Descripción |
|----------|-------|-------------|
| `JWT_SECRET` | `<el string del paso 2>` | Firma los tokens de sesión |
| `DASHBOARD_EMAIL` | `hairol@ejemplo.com` | Email del doctor para login |
| `DASHBOARD_PASSWORD_HASH` | `<el hash del paso 1>` | Hash SHA-256 de la contraseña |
| `DASHBOARD_DOCTOR_ID` | `a92c8fa3-a7ad-40b7-9ecf-970c341d24e2` | UUID del doctor en Supabase |
| `DASHBOARD_DOCTOR_NOMBRE` | `Dr. Hairol Pérez` | Nombre visible en el dashboard |

Railway hace redeploy automático.

### Paso 4 — Servir los archivos estáticos PWA

Los archivos de `public/` (manifest, sw, iconos) tienen que estar accesibles en la **raíz** del dominio del dashboard (no en /api).

**Opción A — Si tu dashboard se sirve desde `flowforcelogistic.com/dashboard/`:**

Sube por FTP a `/dashboard/`:
- `manifest.json`
- `sw.js`
- `icon-192.png`
- `icon-512.png`

Luego edita `manifest.json` y cambia:
```json
"start_url": "/dashboard/",
"scope": "/dashboard/",
```
(ya está así por defecto en el archivo entregado)

**Opción B — Si sirves el dashboard desde Railway directamente:**

En `src/index.ts` añade ANTES de las rutas `/api`:
```typescript
import path from "path";
app.use(express.static(path.join(process.cwd(), "public")));
```

Esto sirve `/manifest.json`, `/sw.js`, `/icon-192.png`, `/icon-512.png` desde la raíz.

### Paso 5 — Deploy

```bash
npm install
npm run build
git add .
git commit -m "feat: login real JWT + bootstrap + PWA"
git push
```

### Paso 6 — Verificar

En los logs de Railway deberías ver:
```
✅ CitasMed API corriendo en http://localhost:3000
   Seguridad: rate-limit + security-headers + request-logger activos
[recordatorios] Iniciando cron cada 15 min
```

Abre el dashboard, debería pedirte credenciales (ya no autollena `doctor@test.com`).

---

## 🧪 Pruebas críticas después del deploy

### Test 1 — Login falla con credenciales incorrectas
1. Abrir dashboard
2. Poner `mala@email.com` + `1234`
3. Debe mostrar "Credenciales incorrectas" (con delay de 1 segundo — anti brute-force)

### Test 2 — Login correcto
1. Poner email y contraseña reales
2. Debe entrar al dashboard
3. El doctor nombre debe aparecer arriba (viene de `DASHBOARD_DOCTOR_NOMBRE`)
4. Las sedes deben cargarse automáticamente (viene del backend, no hardcoded)

### Test 3 — Token persiste al recargar
1. Login correcto
2. F5 (recargar)
3. NO debe volver a pedir login — entra directo

### Test 4 — Logout limpia sesión
1. Click en cerrar sesión
2. Confirmar
3. Debe volver al login

### Test 5 — API ya no tiene la key expuesta
1. Abre DevTools → Sources → `citasmedprocesomjora.html`
2. Busca "medbot_test_2025"
3. No debe aparecer. Solo debe aparecer `getToken()` que lee sessionStorage

### Test 6 — Rate limit del login funciona
1. Intentar hacer login 6 veces rápido con credencial mala
2. El 6to debe devolver 429 "Demasiados intentos"

### Test 7 — PWA instalable
1. En Chrome móvil: debería aparecer banner "Añadir a pantalla de inicio"
2. En Safari iPhone: compartir → "Añadir a pantalla de inicio"
3. En Chrome desktop: barra de URL → icono ⊕ "Instalar CitasMed"
4. Una vez instalada, abre sin barra de URL como app nativa

### Test 8 — Bot sigue funcionando
El bot de Telegram usa la API key original por separado. Sigue funcionando sin cambios.

---

## 🔄 Compatibilidad con el bot

El middleware auth acepta **dos formas** de autenticarse:
- `Authorization: Bearer <JWT>` — el dashboard
- `X-API-Key: <API_SECRET>` — el bot y herramientas internas

Ambas funcionan simultáneamente. El bot no se rompió.

---

## 🎁 Bonus: cómo cambiar la contraseña del doctor

1. Generar nuevo hash (Paso 1)
2. Cambiar `DASHBOARD_PASSWORD_HASH` en Railway
3. El doctor tendrá que re-loguear (tokens viejos de 8h seguirán válidos hasta expirar)

Si quieres invalidar **todos** los tokens activos: cambia también `JWT_SECRET`.

---

## 🔜 Siguiente paso lógico (cuando tengas 5+ doctores)

El sistema actual solo soporta UN doctor vía variables de entorno. Para multi-doctor:

1. Activar Supabase Auth
2. Tabla `usuarios` con rol (según el plan maestro que te entregué)
3. `login.ts` delega a Supabase Auth
4. `bootstrap.ts` ya está listo (usa `req.user.doctor_id`)

Esto es Fase 1 del Plan Maestro. No es urgente hasta que tengas más de 1 doctor activo.
