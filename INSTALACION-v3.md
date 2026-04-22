# 🚀 CitasMed v3 — Guía de instalación

Esta actualización incluye **4 mejoras mayores** sobre la versión anterior:

1. **Bot: Reagendar cita** (tool nueva `reagendar_cita`)
2. **Bot: Validación cédula + detección duplicados**
3. **Backend: Seguridad básica** (rate-limit, headers, logs estructurados)
4. **Recordatorios automáticos 24h + 2h** por Telegram

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
├── recordatorios/
│   └── recordatorios.ts              [NUEVO]
└── scripts/
    └── backup-weekly.sh              [NUEVO]
package.json                          [MODIFICADO: añade node-cron]
INSTALACION-recordatorios.md          [NUEVO]
```

### Paso 3 — Instalar dependencia nueva

Los recordatorios usan `node-cron` para programar los envíos. Los otros middlewares no tienen dependencias.

```bash
npm install
```

Esto instala `node-cron` y `@types/node-cron` automáticamente (ya están en package.json).

### Paso 4 — Crear columnas en Supabase para recordatorios

Abrir el **SQL Editor** en Supabase y ejecutar:

```sql
ALTER TABLE citas
  ADD COLUMN IF NOT EXISTS recordatorio_24h_enviado BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS recordatorio_2h_enviado BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_citas_recordatorios
  ON citas (inicia_en, estado)
  WHERE estado IN ('pendiente', 'confirmada')
    AND (recordatorio_24h_enviado = FALSE OR recordatorio_2h_enviado = FALSE);
```

**Sin estas columnas, el cron de recordatorios dará error al arrancar.**

### Paso 5 — Compilar y desplegar

```bash
npm run build
git add .
git commit -m "feat: reagendar + validaciones + seguridad + recordatorios"
git push
```

Railway detecta el push y redeploya automáticamente.

### Paso 6 — Verificar que todo arrancó

En los logs de Railway deberías ver:

```
✅ CitasMed API corriendo en http://localhost:3000
   Supabase: https://xxxxxxxxxxxxxxx.supabase.co
   Timezone: America/Santo_Domingo
   Seguridad: rate-limit + security-headers + request-logger activos
[recordatorios] Iniciando cron cada 15 min
```

Si ves las dos últimas líneas, todo está bien.

### Paso 7 — Probar en producción

**Test 1 — Reagendar cita:**
1. Abrir Telegram → escribir al bot
2. "Quiero cambiar mi cita"
3. El bot pide código, luego nuevo horario, luego mueve sin cancelar

**Test 2 — Detección de duplicados:**
1. Agendar cita mañana 10 AM
2. Intentar agendar OTRA cita mismo paciente + misma sede + mismo día
3. El bot detecta duplicado y avisa

**Test 3 — Rate limit:**
Hacer clic muy rápido 11 veces seguidas en "Atender" desde el dashboard. El 11vo debe devolver 429.

**Test 4 — Recordatorios:**
- Agendar cita desde Telegram para dentro de ~24 horas
- Esperar al siguiente ciclo :00, :15, :30 o :45
- Los logs de Railway mostrarán: `[recordatorios] Ciclo 24h: N citas candidatas`
- El paciente recibe mensaje en Telegram

Para más detalles sobre los recordatorios ver **INSTALACION-recordatorios.md**.

---

## 🔐 Script de backup semanal

Ver instrucciones completas en `scripts/backup-weekly.sh` (al inicio del archivo).

Resumen rápido:
1. Instalar `postgresql-client` en tu máquina
2. Obtener connection string URI de Supabase → Database
3. Editar la variable `DATABASE_URL` en el script
4. `chmod +x backup-weekly.sh && ./backup-weekly.sh` para probar
5. Programar con cron cada lunes 3 AM

---

## 📊 Qué lograste con esta actualización

| Antes | Ahora |
|-------|-------|
| API sin rate limit | 120 req/min global + 10 en escrituras |
| Sin headers de seguridad | HSTS, X-Frame-Options, X-Content-Type-Options, etc. |
| Logs básicos | Logs estructurados con request-id, latencia, método |
| Payload sin límite | Max 100 KB por request |
| Backups solo de Supabase | Backup semanal adicional a disco |
| Bot sin reagendar | Flujo completo de reagendamiento |
| Bot podía duplicar citas | Detección automática de duplicados |
| Sin validación de cédula | Luhn mod-10 oficial |
| Sin recordatorios | Automáticos 24h + 2h antes por Telegram |

---

## 🔜 Siguientes pasos (próximas sesiones)

- **Lista de espera** (tabla nueva + tool bot)
- **Configuración del doctor** (tab completo: horarios, duración, precios, vacaciones)
- **Sentry + alertas de errores** (cuenta free)
- **Dashboard maestro**
- **WhatsApp** (cuando tengas Meta)
