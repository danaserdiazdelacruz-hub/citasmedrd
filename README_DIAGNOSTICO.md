# 🔬 Diagnóstico — ¿Por qué el FAQ no llega al LLM?

> Este zip **NO arregla nada**. Solo agrega logs temporales para identificar exactamente dónde se pierde el FAQ.

---

## 📁 Archivo en este zip (1)

| Ruta                                | Acción                  |
|-------------------------------------|-------------------------|
| `src/application/orchestrator.ts`   | Reemplazar (existente)  |

Solo agregué 7 líneas de `console.log` en `handleIdleConLLM`. Cero cambios en lógica.

---

## 🚀 Pasos

### 1. Reemplazar el archivo y deployar
Copia el archivo, push a Railway, espera a que esté listo.

### 2. Mandar UN solo mensaje al bot
Desde Telegram, hablale al bot Citasmed RD:
```
aceptan senasa?
```

### 3. Ir a Railway → Logs
Buscar las líneas que empiecen con `[DIAG-FAQ]`. Verás algo así:

```
[DIAG-FAQ] tenant.id: 9881ce90-...
[DIAG-FAQ] tenant.configuracion type: object
[DIAG-FAQ] tenant.configuracion keys: ["asistente_nombre","faq"]
[DIAG-FAQ] faqDelTenant result: {"aceptan_seguros":true,"aseguradoras":[...]}
[DIAG-FAQ] systemPrompt incluye 'Seguros médicos': true
[DIAG-FAQ] systemPrompt incluye 'Senasa': true
[DIAG-FAQ] systemPrompt length: 2890
```

### 4. Mándame los 7 logs

Pegámelos como están en el chat. Con eso te digo exactamente cuál es el problema:

---

## 🧠 Cómo voy a interpretar los logs

| Si veo... | Significa que el problema es... |
|---|---|
| `tenant.configuracion type: undefined` o `null` | El tenant no se está cargando correctamente |
| `keys: ["asistente_nombre"]` (sin `faq`) | Supabase no está devolviendo el FAQ — o estás mirando un tenant distinto al que configuraste |
| `keys: ["asistente_nombre","faq"]` pero `faqDelTenant result: undefined` | Bug en `faqDelTenant()` |
| `faqDelTenant result: {...válido...}` pero `systemPrompt incluye 'Senasa': false` | Bug en el prompt-builder |
| Todo lo de arriba `true` y aún así el LLM responde "no sé sobre seguros" | El LLM se está confundiendo por el historial conversacional contaminado |

---

## ⚠️ Importante

- Este diagnóstico es **temporal**. Una vez identifiquemos el problema, te entrego el archivo limpio sin los logs.
- Los logs no afectan rendimiento ni rompen nada — son solo `console.log`.
- Cero impacto en la lógica del bot.
