# 🩹 Bloque 18 — Cambio de opinión + FAQ ejemplo

> Parche minimal: **1 archivo** modificado + JSON listo para copy-paste en Supabase.

---

## 🐛 El bug que arregla

Del log:

```
> Usuario: "quier saber si puedo cacvelar mi cita"
> Bot: "Estas son tus citas activas: CITA-679242. ¿Cuál cancelar?" [estado→CANCELANDO_CITA]

> Usuario: "quiero agendar otra"   ← cambió de opinión
> Bot: "no entendí" + saludo enriquecido [DOBLE MENSAJE, además ignora la nueva intención]

> Usuario: "hello"
> Bot: "no estoy seguro" + saludo [DOBLE MENSAJE OTRA VEZ]
```

**Causa:** cuando el usuario está en un estado que espera click de botón (`CANCELANDO_CITA`, `ELIGIENDO_SEDE`, etc.) y en lugar de eso escribe texto libre, el bot caía en un fallback genérico que mostraba "no entendí" + menú = 2 mensajes y NO procesaba la intención.

**Fix:** soft-reset a IDLE preservando memoria del paciente y dejar que el LLM procese el texto como cualquier mensaje normal. Esto permite cambios de opinión naturales:

```
> Usuario: "quiero cancelar"
> Bot: muestra citas para elegir [CANCELANDO_CITA]
> Usuario: "mejor agendar otra"
> Bot: detecta intención agendar → inicia flujo de agendar  ✅
```

---

## 📁 Archivos en este zip (1)

| Ruta en el zip                       | Acción                  |
|--------------------------------------|-------------------------|
| `src/application/orchestrator.ts`    | Reemplazar (existente)  |

**Solo 1 archivo. Cero archivos nuevos. Cero migraciones SQL. Cero canibalismo.**

---

## 🔒 Reglas anti-superposición

| Regla | Por qué |
|---|---|
| Solo aplica el soft-reset cuando llega texto en estado ≠ IDLE | Los flujos de botones siguen funcionando 100% igual |
| El soft-reset preserva memoria larga (teléfono, nombre conocidos) | El LLM puede saludar al paciente por nombre y referenciar su cita |
| Después del reset, llama al LLM normalmente — sin ramas nuevas | Reusa el mismo handler `handleIdleConLLM` que ya conocemos y testeamos |
| Estados PIDIENDO_NOMBRE y PIDIENDO_TELEFONO mantienen sus handlers especiales | NO se rompe el flujo de agendar (donde el usuario sí debe escribir nombre/teléfono) |

---

## 🛠️ Lo que NO se tocó

- ✋ Schema de la base de datos
- ✋ FSM (estados de sesión)
- ✋ Repositorios, webhook, idempotencia
- ✋ messages.ts, prompt-builder.ts, tools.ts
- ✋ Bloques anteriores intactos

---

## ✔️ Verificación

- `npm run build` → ✅ compila limpio
- `npm test` → ✅ 70/70 tests pasan

---

## 🧪 Probar después de deploy

### Caso 1 — Cambio de opinión (CANCELANDO → AGENDAR)
```
> /start
> "cancelar mi cita" → muestra citas con botón cancelar
> "mejor agendar otra" → debe iniciar flujo de agendar
```

### Caso 2 — Saludo desde estado raro
```
> /start
> "cancelar mi cita" → muestra citas
> "hola" → debe saludar normal, no doble mensaje
```

### Caso 3 — Flujo normal sin cambios
Los flujos clásicos (agendar/cancelar/consultar con clicks) deben seguir igual.

---

## 📋 FAQ recomendado para Citasmed (copy-paste en Supabase)

Como mencionaste que querías agregar seguros (Senasa, Futuro, Palic...), aquí tienes el JSON listo. Cópialo en:

**Supabase → tabla `tenants` → tu fila → columna `configuracion`**

```json
{
  "asistente_nombre": "María Salud",
  "faq": {
    "aceptan_seguros": true,
    "aseguradoras": [
      "Humano",
      "ARS Universal",
      "Senasa",
      "Mapfre",
      "Palic Salud",
      "Futuro",
      "Renacer",
      "La Colonial"
    ],
    "atiende_emergencias": false,
    "consultas_virtuales": false,
    "atiende_ninos": false,
    "edad_minima": 14,
    "tiene_parqueo": true,
    "tiempo_espera_promedio_min": 15,
    "metodos_pago": ["efectivo", "tarjeta", "transferencia"],
    "indicaciones_previas": "Llegar 15 minutos antes con cédula y resultados de estudios previos si los tienes.",
    "puede_enviar_ubicacion": true,
    "notas_adicionales": "Estacionamiento techado disponible en cada sede."
  }
}
```

**Ajusta los valores** según lo real en Citasmed:
- ¿Realmente aceptan todas esas aseguradoras? Pon solo las que sí.
- ¿Atienden niños? `atiende_ninos: true/false` y `edad_minima` si aplica.
- ¿Tienen virtuales? Cambia a `true` si sí.
- Las indicaciones previas son texto libre — escribe lo que sea apropiado para Citasmed.

Una vez guardado, **se lee fresco en cada turn** (no hace falta reiniciar Railway). Pruebas con "aceptan Senasa?" y debería responder específicamente.

---

## 🤔 Por qué este fix no necesita configuración del FAQ

El fix de cambio-de-opinión es **independiente del FAQ**. Funciona aunque no configures nada. Las dos cosas son separadas:
- **Bug del log** (cambio de opinión) → este zip lo arregla
- **FAQ vacío** (seguros, parqueo, etc.) → tu pasas a configurarlo en Supabase
