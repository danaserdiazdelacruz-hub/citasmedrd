import { getSesion, setSesion, deleteSesion } from "./sesion.js";
import { enviar } from "./telegram.js";
import { rpc, supabase } from "../lib/supabase.js";
import { ENV } from "../lib/env.js";
import { BotSesion } from "./types.js";

const DIAS  = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
const MESES = ["","ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];

function formatFecha(fecha: string): string {
  const d = new Date(fecha + "T12:00:00Z");
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} ${MESES[d.getUTCMonth() + 1]}`;
}

function toHoraRD(isoUtc: string): string {
  return new Date(isoUtc).toLocaleTimeString("es-DO", {
    timeZone: "America/Santo_Domingo",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function fechaHoyRD(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Santo_Domingo" });
}

function validarTelefonoRD(tel: string): string | null {
  const digits = tel.replace(/\D/g, "");
  let numero = digits;
  if (numero.length === 11 && numero.startsWith("1")) numero = numero.slice(1);
  if (numero.length !== 10) return null;
  if (!["809","829","849"].includes(numero.slice(0, 3))) return null;
  return "+1" + numero;
}

// Buscar doctor en Supabase por nombre, apellido o extensión
async function buscarDoctor(texto: string): Promise<any | null> {
  const clean = texto.trim();

  // Buscar por extensión (solo números)
  if (/^\d+$/.test(clean)) {
    const res = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
      extension: `eq.${clean}`,
      activo: "eq.true",
      select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
      limit: "1",
    });
    if (res.data?.[0]) return res.data[0];
  }

  // Buscar por nombre o apellido
  const res = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
    activo: "eq.true",
    or: `nombre.ilike.*${clean}*,apellido.ilike.*${clean}*`,
    select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
    limit: "5",
  });

  if (!res.data || res.data.length === 0) return null;
  if (res.data.length === 1) return res.data[0];

  // Si hay más de uno, devolver lista para que Claude pregunte
  return { multiples: res.data };
}

// Buscar sedes del doctor
async function buscarSedes(doctorId: string): Promise<any[]> {
  const res = await supabase<any[]>("GET", "/rest/v1/doctor_clinica", null, {
    doctor_id: `eq.${doctorId}`,
    activo: "eq.true",
    select: "id,clinicas(nombre,ciudad,direccion,telefono)",
  });
  return res.data ?? [];
}

// Buscar servicios de una sede
async function buscarServicios(dcId: string): Promise<any[]> {
  const res = await supabase<any[]>("GET", "/rest/v1/servicios", null, {
    doctor_clinica_id: `eq.${dcId}`,
    activo: "eq.true",
    invisible_para_pacientes: "eq.false",
    select: "id,nombre,duracion_min,tipo",
  });
  return res.data ?? [];
}

async function buscarSlots(dcId: string, srvId: string, fecha: string): Promise<{texto: string; slots: any[]}> {
  const result = await rpc<any>("fn_slots_con_espacio", {
    p_doctor_clinica_id: dcId,
    p_fecha: fecha,
    p_servicio_id: srvId,
  });
  const slots = (result.data ?? []).slice(0, 8).map((s: any, i: number) => ({
    num: i + 1, hora: toHoraRD(s.inicia_en), inicia_en: s.inicia_en,
  }));
  if (slots.length === 0) return { texto: "No hay horarios disponibles para ese dia.", slots: [] };
  const texto = slots.map((s: any) => `${s.num}. ${s.hora}`).join("\n");
  return { texto, slots };
}

async function agendarCita(sesion: BotSesion, slot: any): Promise<string | null> {
  const nombreParts = (sesion.nombre ?? "Paciente").split(" ");
  const pac = await rpc<any>("fn_get_or_create_paciente", {
    p_telefono: sesion.telefono ?? "",
    p_nombre: nombreParts[0] ?? "Paciente",
    p_apellido: nombreParts.slice(1).join(" ") || "Paciente",
    p_cedula: null, p_fecha_nacimiento: null, p_sexo: null, p_zona: null,
  });
  if (!pac.data?.[0]?.paciente_id) return null;

  const cita = await rpc<any>("fn_agendar_cita", {
    p_doctor_clinica_id: sesion.sede_id,
    p_paciente_id: pac.data[0].paciente_id,
    p_servicio_id: sesion.servicio_id,
    p_inicia_en: slot.inicia_en,
    p_motivo: sesion.motivo ?? "Consulta medica",
    p_canal: "telegram",
    p_creado_por: null,
  });

  if (!cita.data?.[0]?.exito) return null;
  return cita.data[0].codigo;
}

function buildSystemPrompt(sesion: BotSesion, contexto: string): string {
  const hoy = fechaHoyRD();
  const manana = new Date(Date.now() + 86400000).toLocaleDateString("en-CA", { timeZone: "America/Santo_Domingo" });

  return `Eres la recepcionista virtual de una red médica dominicana.
Tu nombre es Asistente CitasMed. Profesional, cálida, directa. Sin emojis.
Máximo 4 líneas por respuesta. Tono clínico y humano a la vez.

HOY: ${hoy} | MAÑANA: ${manana}

INFORMACION REAL DEL SISTEMA (solo usa esto, no inventes nada):
${contexto}

ESTADO ACTUAL:
- Doctor: ${sesion.doctor_nombre ?? "no identificado"}
- Sede: ${sesion.sede_nombre ?? "no seleccionada"}
- Tipo consulta: ${sesion.es_primera === undefined ? "no definido" : sesion.es_primera ? "Primera vez" : "Seguimiento"}
- Nombre paciente: ${sesion.nombre ?? "pendiente"}
- Telefono: ${sesion.telefono ?? "pendiente"}
- Motivo: ${sesion.motivo ?? "pendiente"}
- Horarios mostrados: ${sesion.slots_disponibles ?? "ninguno"}

REGLAS:
1. Solo usa informacion del sistema. Nunca inventes horarios, servicios ni datos.
2. Telefonos dominicanos: 10 digitos, inician con 809, 829 o 849.
3. No aceptes motivos no medicos. Pide el motivo clinico real.
4. Cuando tengas sede + tipo de consulta: incluye [BUSCAR_SLOTS] en tu respuesta.
5. Para cancelar: pide codigo y luego incluye [CANCELAR codigo=XXXX].
6. Usa: "Con gusto", "Perfecto", "Me permite", "Le reservo", "Enseguida".`;
}

async function llamarClaude(historial: {role: string; content: string}[], system: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ENV.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system,
      messages: historial,
    }),
  });
  if (!res.ok) return "Disculpe, tuve un problema tecnico. Puede repetir?";
  const data = await res.json() as { content?: { text?: string }[] };
  return data.content?.[0]?.text?.trim() ?? "Disculpe, no pude procesar su mensaje.";
}

async function extraerDatos(texto: string): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ENV.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `Extrae datos del mensaje. Responde SOLO JSON sin explicaciones ni markdown.
Campos posibles:
- nombre: string (nombre completo de persona real)
- telefono: string (solo digitos, minimo 10)
- motivo: string (SOLO si es claramente medico: dolor, chequeo, sintoma, enfermedad, seguimiento)
- es_primera: boolean (true=primera vez, false=seguimiento/control)
- provincia: string (si menciona lugar donde quiere la cita)
- doctor_busqueda: string (nombre, apellido o extension del doctor que busca)
Solo incluye campos que encuentres claramente.`,
      messages: [{ role: "user", content: texto }],
    }),
  });
  try {
    const data = await res.json() as { content?: { text?: string }[] };
    const text = data.content?.[0]?.text?.trim() ?? "{}";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch { return {}; }
}

export async function procesarMensaje(chatId: string, texto: string): Promise<void> {
  let sesion = await getSesion(chatId);
  const historial: {role: string; content: string}[] = (sesion.historial as any) ?? [];

  const tl = texto.toLowerCase().trim();
  if (texto === "/start" || tl === "hola" || tl === "buenas" || tl === "buenos dias" || tl === "buenas tardes" || tl === "buenas noches" || tl === "inicio") {
    await deleteSesion(chatId);
    sesion = {};
    historial.length = 0;
    const bienvenida = `Bienvenido a la Red de Unidades Oncologicas.\n\nCon gusto le ayudo. Por favor indiqueme el nombre del doctor o la extension con quien desea consultar.`;
    historial.push({ role: "assistant", content: bienvenida });
    sesion.historial = historial as any;
    await setSesion(chatId, sesion);
    await enviar(chatId, bienvenida);
    return;
  }

  // Extraer datos del mensaje
  const datos = await extraerDatos(texto);

  if (datos.nombre && !sesion.nombre) sesion.nombre = datos.nombre;
  if (datos.motivo && !sesion.motivo) sesion.motivo = datos.motivo;
  if (datos.es_primera !== undefined && sesion.es_primera === undefined) sesion.es_primera = datos.es_primera;

  if (datos.telefono && !sesion.telefono) {
    const telValido = validarTelefonoRD(datos.telefono);
    if (telValido) sesion.telefono = telValido;
  }

  // Buscar doctor si no está identificado aún
  if (!sesion.doctor_id && datos.doctor_busqueda) {
    const resultado = await buscarDoctor(datos.doctor_busqueda);

    if (!resultado) {
      historial.push({ role: "user", content: texto });
      const resp = "No encontre ese doctor en el sistema. Por favor verifique el nombre completo o la extension e intentelo nuevamente.";
      historial.push({ role: "assistant", content: resp });
      sesion.historial = historial.slice(-20) as any;
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;
    }

    if (resultado.multiples) {
      // Hay varios doctores con ese nombre — pedir más especificidad
      const lista = resultado.multiples.map((d: any, i: number) =>
        `${i + 1}. Dr. ${d.nombre} ${d.apellido}${d.extension ? ` (ext. ${d.extension})` : ""}`
      ).join("\n");
      historial.push({ role: "user", content: texto });
      const resp = `Encontre varios doctores con ese nombre:\n\n${lista}\n\nPor favor indique el numero o la extension para identificarlo correctamente.`;
      historial.push({ role: "assistant", content: resp });
      sesion.historial = historial.slice(-20) as any;
      sesion.doctores_multiples = resultado.multiples as any;
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;
    }

    // Doctor identificado
    sesion.doctor_id   = resultado.id;
    sesion.doctor_nombre = `Dr. ${resultado.nombre} ${resultado.apellido}`;
    if (resultado.extension) sesion.doctor_extension = resultado.extension;

    // Cargar sedes del doctor desde Supabase
    const sedes = await buscarSedes(resultado.id);
    sesion.sedes_disponibles = sedes as any;
  }

  // Si hay múltiples doctores y el paciente elige uno por número
  if (!sesion.doctor_id && (sesion as any).doctores_multiples) {
    const num = parseInt(texto) - 1;
    const multiples = (sesion as any).doctores_multiples;
    if (!isNaN(num) && num >= 0 && num < multiples.length) {
      const doc = multiples[num];
      sesion.doctor_id = doc.id;
      sesion.doctor_nombre = `Dr. ${doc.nombre} ${doc.apellido}`;
      if (doc.extension) sesion.doctor_extension = doc.extension;
      const sedes = await buscarSedes(doc.id);
      sesion.sedes_disponibles = sedes as any;
      delete (sesion as any).doctores_multiples;
    }
  }

  // Elegir sede por número o provincia
  if (sesion.doctor_id && !sesion.sede_id && (sesion as any).sedes_disponibles) {
    const sedes: any[] = (sesion as any).sedes_disponibles;
    const num = parseInt(texto) - 1;
    let sedeElegida = (!isNaN(num) && num >= 0 && num < sedes.length) ? sedes[num] : null;

    if (!sedeElegida && datos.provincia) {
      sedeElegida = sedes.find((s: any) =>
        s.clinicas?.ciudad?.toLowerCase().includes(datos.provincia.toLowerCase()) ||
        datos.provincia.toLowerCase().includes(s.clinicas?.ciudad?.toLowerCase().split(" ")[0])
      );
    }

    if (sedeElegida) {
      sesion.sede_id    = sedeElegida.id;
      sesion.sede_nombre = `${sedeElegida.clinicas?.nombre} (${sedeElegida.clinicas?.ciudad})`;

      // Cargar servicios de esa sede
      const servicios = await buscarServicios(sedeElegida.id);
      sesion.servicios_disponibles = servicios as any;
    }
  }

  // Resolver servicio si tenemos sede + tipo
  if (sesion.sede_id && sesion.es_primera !== undefined && !sesion.servicio_id) {
    const servicios: any[] = (sesion as any).servicios_disponibles ?? [];
    const srv = sesion.es_primera
      ? servicios.find((s: any) => s.tipo === "primera_vez") ?? servicios[0]
      : servicios.find((s: any) => s.tipo === "normal" || s.tipo === "rapida") ?? servicios[0];
    if (srv) sesion.servicio_id = srv.id;
  }

  // Eligiendo dia por numero
  if (sesion.paso === "elegir_dia" && sesion.dias_disponibles) {
    const num = parseInt(texto) - 1;
    if (!isNaN(num) && num >= 0 && num < sesion.dias_disponibles.length) {
      const fechaSel = sesion.dias_disponibles[num]!.fecha;
      const { texto: slotsTexto, slots } = await buscarSlots(sesion.sede_id!, sesion.servicio_id!, fechaSel);
      sesion.fecha_sel = fechaSel;
      sesion.slots = slots;
      sesion.slots_disponibles = slotsTexto;
      sesion.paso = "elegir_hora";
      const resp = `Para el ${formatFecha(fechaSel)} tengo los siguientes horarios:\n\n${slotsTexto}\n\n¿Cual prefiere?`;
      historial.push({ role: "user", content: texto });
      historial.push({ role: "assistant", content: resp });
      sesion.historial = historial.slice(-20) as any;
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;
    }
  }

  // Eligiendo hora por numero o texto
  if (sesion.paso === "elegir_hora" && sesion.slots && sesion.nombre && sesion.telefono) {
    const num = parseInt(texto) - 1;
    let slotElegido = (!isNaN(num) && num >= 0 && num < sesion.slots.length)
      ? sesion.slots[num] : undefined;

    if (!slotElegido) {
      const textoNorm = texto.toLowerCase().replace(/\s/g, "").replace(".", ":");
      slotElegido = sesion.slots.find(s => {
        const horaNorm = s.hora.toLowerCase().replace(/\s/g, "");
        return horaNorm.includes(textoNorm) || textoNorm.includes(horaNorm.replace(":00","").replace(":30",""));
      });
    }

    if (slotElegido) {
      const codigo = await agendarCita(sesion, slotElegido);
      await deleteSesion(chatId);
      if (!codigo) {
        await enviar(chatId, "Ese horario ya no esta disponible. Escriba /start para seleccionar otro.");
        return;
      }
      await enviar(chatId,
        `Cita reservada correctamente.\n\n` +
        `Doctor: ${sesion.doctor_nombre}\n` +
        `Fecha: ${formatFecha(sesion.fecha_sel!)}\n` +
        `Hora: ${slotElegido.hora}\n` +
        `Paciente: ${sesion.nombre}\n` +
        `Sede: ${sesion.sede_nombre}\n` +
        `Codigo: ${codigo}\n\n` +
        `Guarde este codigo. Si necesita cancelar, envielo aqui o escriba /cancelar.`
      );
      return;
    }
  }

  // Construir contexto real para Claude
  let contexto = "";
  if (sesion.doctor_nombre) {
    contexto += `Doctor identificado: ${sesion.doctor_nombre}`;
    if ((sesion as any).doctor_extension) contexto += ` (ext. ${(sesion as any).doctor_extension})`;
    contexto += "\n";
  }
  if ((sesion as any).sedes_disponibles) {
    const sedes: any[] = (sesion as any).sedes_disponibles;
    contexto += `Sedes disponibles:\n${sedes.map((s: any, i: number) =>
      `${i + 1}. ${s.clinicas?.nombre} — ${s.clinicas?.ciudad}${s.clinicas?.telefono ? ` — Tel: ${s.clinicas.telefono}` : ""}`
    ).join("\n")}\n`;
  }
  if ((sesion as any).servicios_disponibles) {
    const srvs: any[] = (sesion as any).servicios_disponibles;
    contexto += `Servicios disponibles:\n${srvs.map((s: any) => `- ${s.nombre} (${s.duracion_min} min)`).join("\n")}\n`;
  }
  if (!contexto) {
    contexto = "Doctor no identificado aun. Esperar que el paciente indique nombre o extension.";
  }

  // Claude maneja la conversacion
  historial.push({ role: "user", content: texto });
  const system = buildSystemPrompt(sesion, contexto);
  let respuesta = await llamarClaude(historial, system);

  // Procesar [BUSCAR_SLOTS]
  if (respuesta.includes("[BUSCAR_SLOTS]") && sesion.sede_id && sesion.servicio_id) {
    respuesta = respuesta.replace("[BUSCAR_SLOTS]", "").trim();
    const diasResult = await rpc<any>("fn_dias_disponibles", {
      p_doctor_clinica_id: sesion.sede_id,
      p_servicio_id: sesion.servicio_id,
      p_dias_adelante: 14,
      p_max_resultados: 5,
    });
    const dias = diasResult.data ?? [];
    if (dias.length === 0) {
      respuesta += "\n\nNo hay citas disponibles en los proximos 14 dias. Puede intentar con otra sede.";
    } else {
      sesion.dias_disponibles = dias;
      sesion.paso = "elegir_dia";
      const lista = dias.map((d: any, i: number) =>
        `${i + 1}. ${formatFecha(d.fecha)} — ${d.total_slots} horarios disponibles`
      ).join("\n");
      respuesta += `\n\n${lista}\n\n¿Para que dia le reservo?`;
    }
  }

  // Procesar [CANCELAR codigo=XXX]
  const matchCancelar = respuesta.match(/\[CANCELAR codigo=([A-Z0-9-]+)\]/);
  if (matchCancelar) {
    respuesta = respuesta.replace(matchCancelar[0], "").trim();
    let codigo = matchCancelar[1]!.toUpperCase();
    if (!codigo.startsWith("CITA-")) codigo = "CITA-" + codigo;
    const found = await supabase<any[]>("GET", "/rest/v1/citas", null, {
      codigo: `eq.${codigo}`, select: "id,estado", limit: "1",
    });
    if (found.data?.[0] && ["pendiente","confirmada"].includes(found.data[0].estado)) {
      await rpc<any>("fn_cancelar_cita", {
        p_cita_id: found.data[0].id,
        p_motivo_cancel: "cancelada_paciente",
        p_cancelado_por: null,
        p_penalizar_paciente: null,
      });
      respuesta += `\n\nCita ${codigo} cancelada correctamente.`;
      await deleteSesion(chatId);
    } else {
      respuesta += `\n\nNo se encontro una cita activa con el codigo ${codigo}.`;
    }
  }

  historial.push({ role: "assistant", content: respuesta });
  sesion.historial = historial.slice(-20) as any;
  await setSesion(chatId, sesion);
  await enviar(chatId, respuesta);
}
