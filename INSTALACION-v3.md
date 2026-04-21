# 🚀 CitasMed v3 — Guía de instalación

Esta actualización incluye **3 mejoras mayores** sobre la versión anterior:

1. **Bot: Reagendar cita** (tool nueva `reagendar_cita`)
2. **Bot: Validación cédula + detección duplicados**
3. **Backend: Seguridad básica** (rate-limit, headers, logs estructurados)

---

## 📋 Instalación paso a paso

### Paso 1 — Backup primero (por si acaso)

Antes de actualizar, descarga tu código actual de Railway o haz commit en git.

### Paso 2 — Reemplazar archivos

Los siguientes archivos son **nuevos** o **modificados**:

```
src/
├── index.ts                          [MODIFICADO]
├── bot/
│   ├── prompt.ts                     [MODIFICADO]
│   ├── toolDefs.ts                   [MODIFICADO]
│   └── toolExecutors.ts              [MODIFICADO]
├── middleware/
│   ├── rateLimit.ts                  [NUEVO]
│   ├── requestLogger.ts              [NUEVO]
│   └── securityHeaders.ts            [NUEVO]
└── scripts/
    └── backup-weekly.sh              [NUEVO]
```

**No se eliminaron archivos existentes**, solo se agregaron y modificaron. Es seguro copiar el zip completo sobre tu proyecto.

### Paso 3 — No hay dependencias nuevas que instalar

Los middlewares de seguridad están implementados sin dependencias externas (rate-limit, helmet y logger hechos a medida para este proyecto). Esto mantiene el proyecto liviano y predecible.

Solo asegúrate de tener lo que ya usabas:

```bash
npm install
```

### Paso 4 — Compilar y desplegar

```bash
npm run build
git add .
git commit -m "feat: reagendar + validaciones + seguridad"
git push
```

Railway detecta el push y redeploya automáticamente.

### Paso 5 — Verificar que todo arrancó

En los logs de Railway deberías ver:

```
✅ CitasMed API corriendo en http://localhost:3000
   Supabase: https://xxxxxxxxxxxxxxx.supabase.co
   Timezone: America/Santo_Domingo
   Seguridad: rate-limit + security-headers + request-logger activos
```

Si ves esa última línea "Seguridad:..." todo está bien.

### Paso 6 — Probar en producción

Prueba estos 3 flujos:

**Test 1 — Reagendar cita:**
1. Abrir Telegram → escribir al bot
2. "Quiero cambiar mi cita"
3. El bot debe pedir el código
4. Dar un código existente
5. Pedir nuevo día y hora
6. Confirmar → el bot debe decir "su cita se movió al [día] a las [hora]. Su código sigue siendo el mismo"

**Test 2 — Detección de duplicados:**
1. Agendar una cita para mañana 10 AM
2. Intentar agendar OTRA cita mismo paciente + misma sede + mismo día
3. El bot debe detectar el duplicado y avisar

**Test 3 — Rate limit:**
En tu dashboard, intenta hacer clic muy rápido en "Atender" 11 veces seguidas. El 11vo debería devolver error 429.

---

## 🔐 Configurar el script de backup semanal

### Paso 1 — Instalar pg_dump en tu computadora

**Ubuntu/WSL:**
```bash
sudo apt update && sudo apt install postgresql-client
```

**Mac:**
```bash
brew install postgresql
```

**Windows:** Descargar PostgreSQL desde postgresql.org (durante instalación, marcar solo "Command Line Tools")

### Paso 2 — Obtener connection string de Supabase

1. Supabase Dashboard → tu proyecto
2. Project Settings (ícono ⚙️) → Database
3. Connection string → URI
4. Copia la cadena completa, reemplaza `[YOUR-PASSWORD]` con tu password real

### Paso 3 — Configurar el script

```bash
# Copiar el script a una carpeta segura
mkdir -p ~/backups-citasmed
cp scripts/backup-weekly.sh ~/backups-citasmed/
cd ~/backups-citasmed

# Editar y pegar tu connection string
nano backup-weekly.sh
# Buscar la línea DATABASE_URL= y pegar tu cadena

# Dar permisos de ejecución
chmod +x backup-weekly.sh

# Probar manualmente
./backup-weekly.sh
```

Si funciona, verás:
```
[...] Iniciando backup...
  → Destino: /home/usuario/backups-citasmed/citasmed-2026-04-21_1530.sql.gz
[...] ✓ Backup creado: 1.2M
[...] Backups conservados: 1
[...] Listo.
```

### Paso 4 — Programar cron para que corra automático

**Linux/Mac/WSL:**
```bash
crontab -e
```

Añadir esta línea (cada lunes 3 AM):
```
0 3 * * 1 /home/usuario/backups-citasmed/backup-weekly.sh >> /home/usuario/backups-citasmed/backup.log 2>&1
```

**Windows:** Usa Task Scheduler con el mismo schedule.

---

## 📊 Qué lograste con esta actualización

| Antes | Ahora |
|-------|-------|
| API sin rate limit — vulnerable a abuso | Max 120 req/min por IP global + 10 en escrituras |
| Sin headers de seguridad | HSTS, X-Frame, X-Content-Type-Options, Referrer-Policy |
| Logs básicos de `console.log` | Logs estructurados con request-id, latencia, método |
| Payload sin límite | Max 100 KB por request |
| Backups solo de Supabase (Pro) | Backup semanal adicional a tu disco |
| Bot no podía reagendar, solo cancelar | Flujo completo de reagendamiento |
| Bot podía crear citas duplicadas | Detección automática de duplicados |
| Sin validación de cédula | Validación con algoritmo Luhn mod-10 oficial |

---

## 🔜 Siguientes pasos (próximas sesiones)

Cuando vuelvas, podemos trabajar en:

- **Lista de espera** (tabla nueva + tool bot para notificar cupos liberados)
- **Configuración del doctor** (tab completo en dashboard: horarios, duración, precios, vacaciones)
- **Sentry + alertas de errores** (requiere crear cuenta Sentry free tier)
- **Dashboard maestro** (tu panel de admin con métricas globales)
- **WhatsApp** (cuando tengas el número Meta)
