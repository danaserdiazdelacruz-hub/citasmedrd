# 📦 Semana 1 — Día 1-2: Bot multi-doctor estandarizado

> Primera entrega del plan de 60 días. Sin romper nada existente.
> 5 archivos modificados + 2 migraciones SQL pequeñas. Build limpio. 70/70 tests pasan.

---

## ✅ Lo que esta entrega hace

1. **Saludo de CitasMed con disclaimer médico obligatorio** — Spec v1.1 sec 4.2
2. **FAQ por doctor** (no solo por tenant) — Spec v1.1 sec 3.7
3. **Deep-link** `/start <slug>` que pre-identifica al doctor — Spec v1.1 sec 4.1
4. **Validación: cero preguntas sobre motivo de cita** — Spec v1.1 sec 6.3 (ya estaba limpio)

---

## 📁 Archivos en este zip

### Migraciones SQL (correr en orden)
| Archivo | Acción | Idempotente |
|---|---|---|
| `migrations/migration_007_profesional_configuracion.sql` | Agrega `profesionales.configuracion JSONB` | ✅ |
| `migrations/migration_008_profesional_slug.sql` | Agrega `profesionales.slug TEXT` + índice único + auto-genera slugs para los 11 doctores existentes | ✅ |

### Código TypeScript
| Archivo | Acción |
|---|---|
| `src/channels/core/types.ts` | + campo `commandArg?` para deep-links |
| `src/channels/telegram/webhook.ts` | Captura el argumento del comando `/start <arg>` |
| `src/persistence/repositories/profesionales.repo.ts` | + campo `configuracion`, `slug`, método `findBySlug()` |
| `src/application/messages.ts` | + `DISCLAIMER_MEDICO`, `saludoCitasMedConDoctor()`, `opcionesMenuConDoctor()` |
| `src/application/orchestrator.ts` | + `faqDelProfesional()` (con fallback a tenant), handler de deep-link en `/start`, `handleInfoDoctorButton` |

---

## 🚀 Pasos para deployar

### Paso 1 — Correr migración 007 en Supabase

Abre Supabase → SQL Editor → pega el contenido de `migrations/migration_007_profesional_configuracion.sql` → Run.

**Salida esperada:**
```
total_profesionales: 11
con_configuracion: 0
```

### Paso 2 — Correr migración 008

Igual pero con `migrations/migration_008_profesional_slug.sql`.

**Salida esperada:** lista de los 11 doctores con su slug auto-generado:
- `hairol-pérez` (o `hairol-perez` si no tienes la extensión `unaccent`)
- `carmen-vargas`
- `roberto-morales`
- `patricia-guzmán`
- ... etc

⚠️ **Si la query falla por `UNACCENT`**, descomenta la versión más simple en el SQL (incluida en el archivo) y vuelve a correr.

### Paso 3 — Reemplazar archivos en el repo

Copia los 5 archivos del zip a sus rutas en el repo.

### Paso 4 — Build y deploy

```bash
npm run build
# commit + push a Railway
```

### Paso 5 — Pruebas

#### Prueba 1: saludo nuevo de CitasMed

Borra la sesión activa en Supabase (tabla `sesiones_conversacion`, busca por `chat_id` y elimina la fila) o usa otro Telegram.

Manda `/start` al bot.

**Esperado:**
> 👋 ¡Hola! Bienvenido(a) a *CitasMed*.
> Soy *María Salud*, tu asistente.
>
> ⚠️ Solo te ayudo a *agendar citas* e información del consultorio. *No doy consejos médicos ni atiendo emergencias.* Si tienes una emergencia médica, llama al 911.
>
> Para empezar, dime el *nombre, apellido o teléfono* del especialista con quien deseas agendar.

#### Prueba 2: deep-link

Abre el bot con: `https://t.me/TuBotName?start=carmen-vargas` (ajusta al slug real que veas en la migración 008).

**Esperado:**
> 👋 ¡Hola! Soy *María Salud*, asistente virtual de *CitasMed*.
>
> ⚠️ [disclaimer]
>
> Vas a gestionar tu cita con *Dra. Carmen Elena Vargas* 🩺 Ginecología Oncológica
>
> ¿Qué deseas hacer?
> [📅 Agendar cita] [📋 Ver mis citas] [❌ Cancelar/Reagendar] [ℹ️ Información]

Cualquier botón debe arrancar el flujo correspondiente con la Dra. Carmen ya pre-cargada en contexto.

#### Prueba 3: FAQ por doctor (opcional, si quieres validar)

Configura un FAQ específico para Hairol distinto al del tenant:

```sql
UPDATE profesionales
SET configuracion = jsonb_build_object(
  'faq', jsonb_build_object(
    'tiene_parqueo', false,
    'atiende_ninos', true,
    'edad_minima', 0
  )
)
WHERE id = 'c2386b89-6b23-4870-860e-fe47185e93de';  -- Hairol
```

Pregunta al bot "tienen parqueo?" tras llegar por deep-link de Hairol — debe decir NO (sobreescribe el FAQ del tenant).

---

## 🔒 Reglas anti-superposición respetadas

- ✋ Cero canibalismo de los flujos existentes (agendar, cancelar, consultar, reagendar siguen idénticos)
- ✋ FAQ del tenant funciona como FALLBACK si el profesional no tiene FAQ propio (compat retro)
- ✋ Si alguien viene por `/start` SIN slug, el saludo es el genérico (igual que antes pero con disclaimer)
- ✋ Todos los UUIDs y datos de los 11 doctores ficticios siguen intactos
- ✋ Los tests existentes pasan (70/70)
- ✋ Los Bloques 10-21 anteriores siguen funcionando

---

## ✔️ Verificación realizada

- `npm run build` → ✅ compila limpio (sin errores ni warnings)
- `npm test` → ✅ 70/70 tests pasan
- Migraciones SQL idempotentes (seguro re-correr)

---

## 📌 Lo que sigue (Día 3-5 de la Semana 1)

Cuando esto te funcione, seguimos con:
- **Día 3:** Endpoints REST de auth (`/api/login`, `/api/login/me`)
- **Día 4:** Endpoint `/api/bootstrap`
- **Día 5:** Pruebas + buffer

NO arranco con eso hasta que confirmes que esta entrega te funciona en producción.

---

## 🐛 Si algo falla

Si después de deployar ves comportamiento raro:

1. **Revisa los logs de Railway** y pásamelos
2. **Confirma que las 2 migraciones SQL se corrieron**:
   ```sql
   SELECT column_name FROM information_schema.columns
   WHERE table_name='profesionales' AND column_name IN ('configuracion','slug');
   ```
   Debe devolver 2 filas.
3. **Confirma que los slugs se generaron**:
   ```sql
   SELECT slug FROM profesionales WHERE tenant_id='9881ce90-c4fe-459c-a5ef-70ab81121232' LIMIT 5;
   ```
   No deben ser NULL.

Si hay algún error específico, mándamelo y lo resolvemos antes de avanzar a Día 3.
