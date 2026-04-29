# 🩺 Bloque 20 — Fase 2: Backend ahora usa los datos enriquecidos

> 3 archivos modificados, 0 archivos nuevos. Cero migraciones SQL.
> El código ya estaba pidiendo todo esto — solo faltaba que las consultas trajeran los campos.

---

## 📁 Archivos en este zip (3)

| Ruta en el zip                                              | Acción     |
|-------------------------------------------------------------|------------|
| `src/persistence/repositories/profesionales.repo.ts`        | Reemplazar |
| `src/application/llm/prompt-builder.ts`                     | Reemplazar |
| `src/application/orchestrator.ts`                           | Reemplazar |

---

## ✅ Qué cambia

### 1. Repo de profesionales
- Interface `Profesional` ahora incluye `especialidad` y `telefono` (WhatsApp)
- Interface `ProfesionalSede` ahora incluye `extension`
- `listarActivos`, `findById`, `buscarPorNombre` y `listarSedesPorProfesional` traen los nuevos campos en el SELECT
- Nuevo método `listarAseguradorasDeProfesional(profesionalId)` que lee la tabla `profesional_aseguradora`

### 2. Prompt builder
- `ProfesionalResumen` ahora soporta `whatsapp` y `aseguradoras[]`
- `SedeResumen` ahora soporta `extension`
- El prompt los muestra de forma natural:
  - Doctor: `📱 WhatsApp directo: +18092157744`
  - Doctor: `💳 Acepta: SENASA, MAPFRE, UNIVERSAL, PALIC`
  - Sede: `☎️ +18095478601 Ext. 1012`

### 3. Orchestrator
- En `handleIdleConLLM`, antes de armar el prompt, carga las aseguradoras de cada uno de los primeros 5 doctores **en paralelo** (Promise.all)
- Pasa `extension` de cada `profesional_sede` al prompt

---

## 🧪 Lo que el bot podrá responder ahora

| Pregunta del paciente | Respuesta esperada |
|---|---|
| ¿Qué doctores tienen? | Lista los doctores con su especialidad y experiencia |
| ¿Quién es la Dra. Carmen? | "Es nuestra ginecóloga oncológica con 18 años de experiencia. Atiende en Centro Médico María Dolores." |
| ¿Cuál es la extensión del Dr. Miguel? | "1025 en Centro Médico María Dolores." |
| ¿Cuál es el WhatsApp del Dr. Roberto? | "+18292157744" |
| ¿El Dr. Roberto acepta SENASA? | "Sí, también acepta MAPFRE, UNIVERSAL y PALIC." |
| ¿Quién atiende los sábados? | (lee horarios) |

---

## 🔒 Reglas anti-superposición que respeté

| Regla | Cómo |
|---|---|
| Las nuevas columnas son opcionales (TS marca `\| null`) | El código no falla si un doctor no tiene WhatsApp/extensión/aseguradoras |
| Si la tabla `profesional_aseguradora` no existe (DB vieja), devuelve [] silenciosamente | Resiliencia, no rompe |
| Si la consulta de aseguradoras falla, se loguea WARN y el doctor aparece sin aseguradoras | El prompt sigue construyéndose |
| Promise.all paraleliza las consultas de aseguradoras (no son secuenciales) | Sin penalty de latencia perceptible |
| Cero cambios en FSM, webhook, handlers de botones | Bloques 10-19 intactos |

---

## ⚠️ Limitación importante (revisar)

El prompt solo incluye los **primeros 5 doctores** del tenant. Tu DB ahora tiene 11. Si el paciente pregunta "¿hay un Dr. Carlos?" y Carlos está en posición 10, el LLM no lo verá en el prompt directamente.

**Solución:** la búsqueda por nombre (Bloque 12) sigue funcionando. Si el paciente menciona explícitamente un doctor, el LLM invoca `buscar_profesional` y se busca en TODA la DB (no solo en los primeros 5).

Si quisieras que el prompt incluya todos los 11 doctores, súbelo a 12 o 15 (variable: línea `slice(0, 5)`). Pero mientras más doctores, más tokens y más costo por mensaje.

---

## ✔️ Verificación

- `npm run build` → ✅ compila limpio
- `npm test` → ✅ 70/70 tests pasan
- Sin warnings nuevos

---

## 🧪 Probar después de deploy

Después de copiar los 3 archivos y redeployar, prueba en Telegram:

1. `/start`
2. "¿Qué doctores tienen?"
3. "¿Quién es la Dra. Carmen?"
4. "¿El Dr. Roberto acepta SENASA?"
5. "¿Cuál es la extensión del Dr. Miguel?"
6. "Quiero agendar con la Dra. Patricia" (debería ir directo al flujo)

Si responde con la información correcta de la DB, ✅ todo funciona.

---

## 🔮 Pendientes futuros (no incluidos)

- **Bloque 12.B**: Búsqueda por extensión telefónica del doctor (necesitaría una tool `buscar_profesional_por_extension`)
- **Bloque 13**: Memoria larga del paciente >24h
- **Bloque 15**: Seguridad (validación de webhook, cifrado, limpieza de PII en logs)

Cuando quieras seguir, avísame.
