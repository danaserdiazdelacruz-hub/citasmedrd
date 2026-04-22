# 📬 Recordatorios Automáticos — Instalación

## Qué hace este módulo
Envía automáticamente por Telegram recordatorios al paciente:
- **24 horas antes** de su cita: mensaje completo con fecha, hora, sede, doctor, código
- **2 horas antes** de su cita: recordatorio corto "su cita es en 2 horas"

Corre cada 15 minutos en el servidor Railway. Solo envía recordatorios a pacientes que agendaron por Telegram (por ahora). Cuando añadamos WhatsApp, se expandirá automáticamente.

---

## Paso 1: Subir archivo al proyecto

Copiar `recordatorios.ts` a la carpeta:
```
citasmed-v2/src/recordatorios/recordatorios.ts
```

(Crear la carpeta `recordatorios/` si no existe)

---

## Paso 2: Instalar dependencia

En la terminal, dentro del proyecto:
```bash
npm install node-cron
npm install --save-dev @types/node-cron
```

---

## Paso 3: Crear columnas en Supabase

Abrir el **SQL Editor** en Supabase y ejecutar:

```sql
ALTER TABLE citas
  ADD COLUMN IF NOT EXISTS recordatorio_24h_enviado BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS recordatorio_2h_enviado BOOLEAN DEFAULT FALSE;

-- Índice para que la consulta del cron sea rápida
CREATE INDEX IF NOT EXISTS idx_citas_recordatorios
  ON citas (inicia_en, estado)
  WHERE estado IN ('pendiente', 'confirmada')
    AND (recordatorio_24h_enviado = FALSE OR recordatorio_2h_enviado = FALSE);
```

---

## Paso 4: Activar en `src/index.ts`

En la última línea del archivo, después de `app.listen(...)`, añadir:

```typescript
import { iniciarRecordatorios } from "./recordatorios/recordatorios";

// ... el código existente ...

app.listen(PORT, () => {
  console.log(`Server on :${PORT}`);
  iniciarRecordatorios();  // ← NUEVA LÍNEA
});
```

---

## Paso 5: Verificar que `bot_sesiones` guarda `chat_id`

Si no lo guarda, el recordatorio no sabrá a qué chat enviar. Verificar con:

```sql
SELECT chat_id, canal, actualizado_en
FROM bot_sesiones
ORDER BY actualizado_en DESC
LIMIT 10;
```

Si `chat_id` viene vacío, avisar para corregir el bot.

---

## Paso 6: Deploy a Railway

Railway detecta el cambio en Git y hace redeploy automático. Los logs mostrarán:

```
[recordatorios] Iniciando cron cada 15 min
[recordatorios] Tick 2026-04-21T00:00:00.000Z
[recordatorios] Ciclo 24h: 2 citas candidatas
[recordatorios] Enviado 24h a Juan Pérez para cita CITA-A3F2B1
```

---

## Cómo probarlo

1. Agendar una cita desde Telegram para dentro de ~24 horas
2. Esperar al siguiente ciclo de 15 min (:00, :15, :30, :45)
3. Revisar los logs de Railway
4. Recibir mensaje en Telegram

**Tip:** Para pruebas rápidas, editar temporalmente las ventanas en `recordatorios.ts`:
```typescript
// DEBUG: ventana de prueba de 1 minuto
const v24Inicio = new Date(ahora.getTime() - 60000);
const v24Fin = new Date(ahora.getTime() + 60000);
```

---

## Limitaciones actuales

- **Solo Telegram**: si el paciente agendó por dashboard o manualmente, no recibe recordatorio
- **Solución futura**: cuando tengamos WhatsApp, ampliar `resolverChatIdTelegram()` a un `resolverCanalPaciente()` que use `wa.me` o Meta Cloud API
- **Sin confirmación de lectura**: Telegram Bot API no notifica si el paciente leyó
- **Sin reagendamiento directo**: el paciente tendría que escribir al bot. Sería bueno añadir botones inline "Confirmar" / "Cancelar" / "Reagendar" en el mensaje

---

## Mejoras pendientes (para otra sesión)

1. Botones inline con acciones directas (requiere manejar callbacks de Telegram)
2. Personalizar texto por doctor (algunos podrían querer un tono diferente)
3. Permitir al doctor desactivar recordatorios para ciertos pacientes
4. Registrar en `eventos_auditoria` cuando se envía un recordatorio (compliance)
5. Envío por WhatsApp cuando el paciente lo tenga
