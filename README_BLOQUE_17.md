# 🩹 Bloque 17 — 3 fixes a problemas observados en producción

> Parche reactivo a problemas reales del log que compartiste.
> **Cero migraciones SQL. Cero cambios en DB schema.**

---

## 🐛 Los 3 problemas que arregla

### Problema 1 — Doble respuesta robótica
En el log se vio:
```
> Usuario: aceptan seguro
> Bot: Como te comenté, no tengo esa información... [LLM]
> Bot: ¡Hola! 😊 Bienvenido(a)... [MENÚ DUPLICADO]
```

**Causa:** después de que el LLM respondía con texto natural, el orquestador SIEMPRE agregaba el menú principal al final, generando 2 mensajes a una sola pregunta.

**Fix:** si el LLM da una respuesta natural, ese mensaje basta. Solo se muestra el menú si el LLM no respondió nada (caso raro).

### Problema 2 — Preguntas de info clasificadas como `consultar`
En el log también se vio "No tengo citas activas" como tercer mensaje a la pregunta "aceptan seguro". Eso se da porque el LLM clasificaba "aceptan seguro" como intención `consultar` (ver mis citas), entonces el bot preguntaba por citas en lugar de responder la pregunta.

**Causa:** el system prompt era ambiguo entre "preguntar información" vs "querer consultar mis citas".

**Fix:** reforzado el prompt con regla explícita y 5 ejemplos:
- "aceptan seguros?" / "tienen parqueo?" / "qué servicios?" → INFO con texto
- "ver mis citas" / "qué cita tengo?" → intencion=consultar

### Problema 3 — `/Star` (mal escrito) no se reconocía
En el log:
```
> Usuario: /Star
> Bot: Mmm, no estoy seguro de qué necesitas...
```

**Causa:** el comando es case-sensitive y Telegram NO lo registra como bot_command si el usuario lo escribe mal.

**Fix:**
- En `webhook.ts`: comandos detectados por Telegram ahora se normalizan a lowercase (`/Start` → `start`, `/MENU` → `menu`).
- En `orchestrator.ts`: además, si el usuario escribe texto que **parece** un slash command (incluyendo typos como `/Star` sin la "t" final), se interpreta tolerantemente.

Tolera variaciones tipo:
- `/Star`, `/Starts`, `/inicio`, `/comenzar` → start
- `/Menú`, `/Menus` → menu
- `/Cancela`, `/salir` → cancelar

---

## 📁 Archivos en este zip (5)

Las rutas dentro del zip respetan la estructura del proyecto.

| Ruta en el zip                                | Acción                  |
|-----------------------------------------------|-------------------------|
| `src/domain/comandos.ts`                      | **NUEVO** — crear        |
| `src/application/llm/prompt-builder.ts`       | Reemplazar (existente)  |
| `src/application/orchestrator.ts`             | Reemplazar (existente)  |
| `src/channels/telegram/webhook.ts`            | Reemplazar (existente)  |
| `tests/unit/comandos.test.ts`                 | **NUEVO** — crear        |

---

## 🔒 Reglas anti-superposición que respeté

| Regla | Por qué |
|---|---|
| Solo elimino el menú extra cuando el LLM **sí** dio texto | Si el LLM falla, sigue mostrando menú como fallback |
| El prompt-builder agrega ejemplos pero NO cambia la lógica de detect_intencion | La tool sigue funcionando igual, solo con reglas más claras |
| `textoComoComando` solo reconoce comandos YA soportados | No introduce comandos nuevos, solo tolera typos |
| Comandos detectados por Telegram + texto-como-comando van por la misma función `handleCommand` | Una sola lógica de comandos, no dos paths divergentes |
| El `text-as-command` NO se aplica si el texto es largo (>20 chars) | Evita falsos positivos como "/start podrías ayudarme..." |

---

## 🛠️ Lo que NO se tocó

- ✋ Schema de la base de datos
- ✋ FSM (estados de sesión)
- ✋ Idempotencia, mutex
- ✋ Repositorios
- ✋ messages.ts
- ✋ Tools del LLM (las 4 existentes siguen igual)
- ✋ Lógica del FAQ (solo se enriqueció el prompt)
- ✋ Bloques 10-16 todos siguen iguales

---

## ✔️ Verificación realizada

- `npm run build` → ✅ compila limpio
- `npm test` → ✅ **70/70 tests pasan** (subimos de 56 a 70 con los 14 nuevos de comandos)
- Sin warnings nuevos

Tests por módulo:
- 19 validators
- 17 datetime
- 11 historial
- 9 horarios
- **14 comandos (nuevos)**

---

## 🧪 Probar después de deploy

### Caso 1 (Doble respuesta arreglada)
```
> Usuario: aceptan seguro
> Bot: [una sola respuesta natural según FAQ]
```
Si el FAQ está vacío en Supabase, la respuesta dirá "te recomiendo llamar al consultorio". **Esto NO es un bug — significa que falta configurar el FAQ.**

### Caso 2 (Info ≠ consultar arreglado)
```
> Usuario: aceptan seguro
> Bot: [responde según FAQ, NO pregunta por citas]
```

### Caso 3 (Comandos tolerantes)
```
> /Start → funciona
> /STAR → funciona
> /Menu → funciona
> /Menú → funciona
> /Cancela → funciona
```

---

## ⚠️ Recordatorio importante

**El FAQ debe estar configurado en Supabase para que el bot responda preguntas como "aceptan seguro".** Si no lo tienes configurado, el bot SEGUIRÁ diciendo "te recomiendo llamar al consultorio" — eso es por diseño, no es un bug.

Configura en Supabase → tabla `tenants` → columna `configuracion`:

```json
{
  "asistente_nombre": "María Salud",
  "faq": {
    "aceptan_seguros": true,
    "aseguradoras": ["Humano", "ARS Universal", "Senasa"],
    "tiene_parqueo": true,
    "atiende_emergencias": false,
    "metodos_pago": ["efectivo", "tarjeta", "transferencia"],
    "indicaciones_previas": "Llegar 15 min antes con cédula y resultados previos."
  }
}
```
