# 📚 Bloque 16 — Bot informado: prompt enriquecido + FAQ configurable

> Parche minimal. **Sin migraciones SQL. Sin cambios en DB schema.**
> El bot ahora puede responder las 19 preguntas frecuentes de pacientes.

---

## 📁 Archivos en este zip (4)

Las rutas dentro del zip respetan la estructura del proyecto. Solo copia y reemplaza.

| Ruta en el zip                               | Acción                  |
|----------------------------------------------|-------------------------|
| `src/domain/horarios.ts`                     | **NUEVO** — crear        |
| `src/application/llm/prompt-builder.ts`      | Reemplazar (existente)  |
| `src/application/orchestrator.ts`            | Reemplazar (existente)  |
| `tests/unit/horarios.test.ts`                | **NUEVO** — crear        |

---

## ✅ Qué cambia

### Cambio 1 — El bot ahora ve TODA la info que ya está en la DB

Antes el LLM solo recibía nombres de profesionales/sedes/servicios. Ahora recibe:

- **Profesionales:** nombre, prefijo, bio corta, años de experiencia
- **Sedes:** nombre, ciudad, dirección completa, teléfono, si tiene coordenadas
- **Servicios:** nombre, descripción pública, precio (con moneda), duración
- **Horarios de atención:** agrupados de forma legible ("Lun, Mar, Vie: 08:00-12:00, 14:00-17:00")

Datos que **ya estaban en tu DB** pero el bot no los ofrecía. Solo enriquecimos el prompt.

### Cambio 2 — FAQ configurable por tenant

Aprovecha el campo `tenants.configuracion` (jsonb) que ya existe. Configurable en Supabase:

```json
{
  "asistente_nombre": "María Salud",
  "faq": {
    "atiende_emergencias": false,
    "consultas_virtuales": false,
    "atiende_ninos": true,
    "tiene_parqueo": true,
    "tiempo_espera_promedio_min": 15,
    "indicaciones_previas": "Llegar 10 min antes con cédula y resultados previos si los tienes",
    "puede_enviar_ubicacion": true,
    "metodos_pago": ["efectivo", "tarjeta", "transferencia"],
    "aceptan_seguros": true,
    "aseguradoras": ["Humano", "ARS Universal", "Senasa"],
    "edad_minima": 0,
    "edad_maxima": 99,
    "notas_adicionales": "Estacionamiento techado disponible. Entrada por la calle de atrás."
  }
}
```

**Todos los campos son opcionales.** Si no configuras un campo, el bot dirá: *"Para esa pregunta te recomiendo llamar al consultorio."*

---

## 🩺 Las 19 preguntas que ahora responde

| # | Pregunta | De dónde sale |
|---|----------|---------------|
| 1 | ¿Qué servicios ofrecen? | Tabla `servicios` (con precio y duración) |
| 2 | ¿Qué especialista me puede atender? | Tabla `profesionales` (con bio + experiencia) |
| 3 | ¿Tienen citas hoy? | El bot consulta slots cuando se inicia el flujo |
| 4 | ¿Costo de la consulta? | `servicios.precio` (ahora visible al LLM) |
| 5 | ¿Aceptan mi seguro? | FAQ → `aceptan_seguros` y `aseguradoras` |
| 6 | ¿Dónde están ubicados? | `sedes.direccion` + `ciudad` (ahora completas) |
| 7 | ¿Horario de atención? | Tabla `horarios_atencion` (resumida legible) |
| 8 | ¿Cómo agendar? | El bot guía el flujo |
| 9 | ¿Cambiar/cancelar? | El bot tiene esos flujos |
| 10 | ¿Atienden emergencias? | FAQ → `atiende_emergencias` |
| 11 | ¿Consultas virtuales? | FAQ → `consultas_virtuales` |
| 12 | ¿Métodos de pago? | FAQ → `metodos_pago` |
| 13 | ¿Cuánto dura la consulta? | `servicios.duracion_min` |
| 14 | ¿Qué llevar? | FAQ → `indicaciones_previas` |
| 15 | ¿Atienden niños? | FAQ → `atiende_ninos` + `edad_minima/maxima` |
| 16 | ¿Hay parqueo? | FAQ → `tiene_parqueo` |
| 17 | ¿Tiempo de espera? | FAQ → `tiempo_espera_promedio_min` |
| 18 | ¿Doctor específico? | Búsqueda por nombre (Bloque 12) |
| 19 | ¿Enviar ubicación por chat? | FAQ → `puede_enviar_ubicacion` |
| 20 | ¿Qué hacer antes? | FAQ → `indicaciones_previas` |

---

## 🔒 Reglas anti-superposición que respeté

| Regla | Por qué |
|---|---|
| Las interfaces del prompt builder mantienen retrocompatibilidad | Los campos nuevos son opcionales, no rompen llamadas existentes |
| Si una consulta a DB falla (sedes/servicios/horarios), se loguea WARN y el resto del prompt se construye con lo que sí funcionó | Resiliencia |
| El FAQ se valida defensivamente: si no es objeto plano, devuelve undefined | No rompe si el JSON está mal formado |
| Solo se enriquece el prompt en `handleIdleConLLM` | No hay impacto en flujos de botones / FSM determinístico |
| Si el LLM no funciona, fallback al menú igual que antes | Sin nuevos puntos de fallo |

---

## 🛠️ Lo que NO se tocó

- ✋ Schema de la base de datos (cero migraciones SQL)
- ✋ FSM (estados de sesión)
- ✋ Webhook, idempotencia, mutex
- ✋ Repositorios (sigo usando los métodos existentes)
- ✋ Tools del LLM (ningún cambio en tools.ts)
- ✋ messages.ts (ningún cambio)
- ✋ Flujos determinísticos de agendar/cancelar/reagendar
- ✋ Bloques 10, 10.1, 11, 12, 14 (todos siguen iguales)

---

## ⚙️ Tamaño del prompt

El prompt enriquecido sigue siendo compacto. Estimación:
- Sin FAQ: ~1,200 tokens (vs ~600 antes)
- Con FAQ típico: ~1,400 tokens

Por turno del LLM, esto agrega ~$0.001 USD adicional con Claude Haiku 4.5. Totalmente manejable.

Si en algún momento ves que el prompt se infla (consultorio con muchos servicios), podemos limitar a top-N por orden o por más relevantes — el código ya recorta a 12 servicios y 5 profesionales.

---

## ✔️ Verificación realizada

- `npm run build` → ✅ compila limpio
- `npm test` → ✅ 56/56 tests pasan (subimos de 47 a 56 con los 9 nuevos de horarios)
- Sin warnings nuevos

---

## 🧪 Cómo configurar tu FAQ después de deploy

1. En Supabase → Table Editor → tabla `tenants` → tu fila
2. Click en la celda `configuracion`
3. Edita el JSON. Si actualmente está `{}`, reemplaza con:

```json
{
  "asistente_nombre": "María Salud",
  "faq": {
    "atiende_ninos": true,
    "tiene_parqueo": true,
    "metodos_pago": ["efectivo", "tarjeta", "transferencia"],
    "aceptan_seguros": false,
    "indicaciones_previas": "Llegar 10 min antes. Trae tu cédula y resultados de estudios previos si los tienes."
  }
}
```

4. Save. Ya. **No hace falta reiniciar nada** — se lee fresco en cada turn.

Si más tarde quieres agregar `consultas_virtuales: true` solo agregas esa línea. Los campos vacíos no rompen nada.

---

## 🧪 Probar después de deploy

Mensajes que deberían recibir respuesta concreta:

1. "que servicios tienen?" → lista con precios y duración
2. "donde están ubicados?" → dirección completa + ciudad
3. "que horario tienen?" → "Lun-Vie: 08:00-17:00..."
4. "cuánto cuesta la consulta?" → precio del servicio principal
5. "atienden niños?" → respuesta según FAQ
6. "tienen parqueo?" → según FAQ
7. "aceptan seguros?" → según FAQ
8. "que tengo que llevar?" → indicaciones previas según FAQ
9. "envíame la ubicación" → si está activado, el LLM puede ofrecer coordenadas (próxima iteración: implementar el envío real de ubicación nativa de Telegram)

Mensajes que **deberían declinar honestamente** (si no configuras el FAQ):
- "tienen pediatra?" sin FAQ → "te recomiendo llamar al consultorio para confirmar"
