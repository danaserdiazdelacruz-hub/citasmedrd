// src/application/intents/llm-handler.ts
// Manejo completo del turno LLM: assembly, call, tool routing.
// Devuelve FlowResult con acciones DECLARATIVAS — nunca llama flows directamente.

import { callLLM, buildSystemPrompt, ALL_TOOLS, LLMUnavailableError } from "../llm/index.js";
import { profesionalesRepo } from "../../persistence/repositories/index.js";
import { consultarCitasActivasPorTelefono } from "../use-cases/index.js";
import { extraerHistorialParaLLM } from "../../domain/historial.js";
import { resumirHorariosAtencion } from "../../domain/horarios.js";
import { formatFechaHora } from "../../domain/datetime.js";
import type { FlowContext, FlowResult } from "../types.js";
import { logInfo, logWarn, logError } from "../types.js";
import { fxSend, fxAppendAssistant } from "../effects/runner.js";
import { nombreAsistenteDe, faqDelProfesional, faqDelTenant } from "../config/resolver.js";
import type { Tenant, SesionConversacion } from "../../persistence/repositories/index.js";

export interface LLMHandlerInput {
  ctx: FlowContext;
  sesion: SesionConversacion;
  texto: string;
  tenant: Tenant | null;
}

export interface LLMHandlerResult {
  result: FlowResult;
  /** Si el LLM detectó intención de buscar profesional y la confianza es alta */
  buscarProfesional?: { nombreQuery: string; intencion: string };
  /** Si el LLM detectó intención de agendar/consultar/cancelar */
  intencionDetectada?: string;
}

export async function handleLLM(input: LLMHandlerInput): Promise<LLMHandlerResult> {
  const { ctx, sesion, texto, tenant } = input;

  try {
    const profesionales = await profesionalesRepo.listarActivos(ctx.tenantId);
    const profesionalesParaPrompt = profesionales.slice(0, 5);

    const aseguradorasPorDoctor = await Promise.all(
      profesionalesParaPrompt.map(async p => {
        try {
          const arr = await profesionalesRepo.listarAseguradorasDeProfesional(p.id);
          return arr.map((a: { nombre: string }) => a.nombre);
        } catch {
          return [] as string[];
        }
      }),
    );

    const profesionalesResumen = profesionalesParaPrompt.map((p, i) => ({
      display: `${p.prefijo} ${p.nombre} ${p.apellido}`,
      especialidad: p.especialidad ?? undefined,
      bio: p.bio_corta,
      anosExperiencia: p.anos_experiencia,
      whatsapp: p.telefono,
      aseguradoras: aseguradorasPorDoctor[i],
    }));

    let sedesResumen: Array<{
      nombre: string; ciudad?: string | null; direccion?: string | null;
      telefono?: string | null; tieneUbicacion?: boolean; extension?: string | null;
    }> = [];
    let serviciosResumen: Array<{
      nombre: string; descripcion?: string | null; precio?: number;
      duracionMin?: number; moneda?: string;
    }> = [];
    let horariosResumen: Array<{ texto: string }> = [];

    if (profesionales.length > 0) {
      const primero = profesionales[0];
      try {
        const sedes = await profesionalesRepo.listarSedesPorProfesional(ctx.tenantId, primero.id);
        sedesResumen = sedes.map(s => ({
          nombre: s.sede.nombre,
          ciudad: s.sede.ciudad,
          direccion: s.sede.direccion,
          telefono: s.sede.telefono,
          tieneUbicacion: s.sede.latitud !== null && s.sede.longitud !== null,
          extension: s.profesionalSede.extension,
        }));
        if (sedes.length > 0) {
          const primeraPS = sedes[0].profesionalSede;
          try {
            const servs = await profesionalesRepo.listarServiciosPublicos(primeraPS.id);
            serviciosResumen = servs.slice(0, 12).map(s => ({
              nombre: s.nombre,
              descripcion: s.descripcion_publica,
              precio: s.precio,
              duracionMin: s.duracion_min,
              moneda: s.moneda,
            }));
          } catch (err) {
            logWarn(ctx.logCtx, "no pude listar servicios para prompt", { err: String(err) });
          }
          try {
            const horarios = await profesionalesRepo.listarHorariosAtencion(primeraPS.id);
            horariosResumen = resumirHorariosAtencion(horarios).map(t => ({ texto: t }));
          } catch (err) {
            logWarn(ctx.logCtx, "no pude listar horarios para prompt", { err: String(err) });
          }
        }
      } catch (err) {
        logWarn(ctx.logCtx, "no pude listar sedes para prompt", { err: String(err) });
      }
    }

    let citaActivaResumen: { servicio: string; fechaHora: string; codigo: string; doctor?: string } | undefined;
    const telConocido = sesion.contexto["paciente_telefono_conocido"] as string | undefined;
    if (telConocido) {
      try {
        const citas = await consultarCitasActivasPorTelefono(ctx.tenantId, telConocido);
        if (citas.length > 0) {
          const c = citas[0];
          citaActivaResumen = {
            servicio: c.servicioNombre,
            fechaHora: formatFechaHora(c.iniciaEn, ctx.logCtx.tz),
            codigo: c.codigo,
            doctor: `${c.profesionalNombre} ${c.profesionalApellido}`.trim(),
          };
        }
      } catch { /* no crítico */ }
    }

    const nombreConocido = sesion.contexto["paciente_nombre_conocido"] as string | undefined;

    const systemPrompt = buildSystemPrompt({
      nombreClinica: tenant?.nombre_comercial ?? "la clínica",
      tipoEntidad: tenant?.tipo_entidad ?? "individual",
      profesionales: profesionalesResumen,
      sedes: sedesResumen,
      servicios: serviciosResumen,
      horarios: horariosResumen,
      estadoSesion: "IDLE",
      pacienteNombre: nombreConocido,
      citaActiva: citaActivaResumen,
      nombreAsistente: nombreAsistenteDe(tenant),
      faq: profesionales.length > 0
        ? faqDelProfesional(profesionales[0], tenant)
        : faqDelTenant(tenant),
    });

    const llmRes = await callLLM({
      systemPrompt,
      history: extraerHistorialParaLLM(sesion.historial, texto),
      userMessage: texto,
      tools: ALL_TOOLS,
      maxTokens: 512,
    });

    const textoLLM = llmRes.text.trim();

    const effects: FlowResult["effects"] = [];

    if (textoLLM.length > 0) {
      effects.push(fxAppendAssistant(ctx.sesionId, textoLLM));
    }

    // Detectar intención
    let intencionDetectada: string | undefined;
    const intencionTool = llmRes.toolUses.find(t => t.name === "detectar_intencion");
    if (intencionTool) {
      const confianza = (intencionTool.input["confianza"] as number) ?? 0;
      if (confianza >= 0.7) {
        intencionDetectada = intencionTool.input["intencion"] as string;
      }
    }

    // Detectar búsqueda de profesional (acción declarativa, no ejecutar)
    const buscarProfTool = llmRes.toolUses.find(t => t.name === "buscar_profesional");
    if (buscarProfTool) {
      const nombreQuery = (buscarProfTool.input["nombre_query"] as string ?? "").trim();
      if (
        nombreQuery.length >= 2
        && (intencionDetectada === "agendar" || intencionDetectada === "horarios")
      ) {
        logInfo(ctx.logCtx, "LLM detectó búsqueda de profesional", { query: nombreQuery });
        return {
          result: { effects },
          buscarProfesional: { nombreQuery, intencion: intencionDetectada! },
          intencionDetectada,
        };
      }
    }

    logInfo(ctx.logCtx, "LLM resp", {
      tieneTexto: textoLLM.length > 0,
      intencion: intencionDetectada,
    });

    if (textoLLM.length > 0) {
      effects.push(fxSend({ kind: "text", text: textoLLM }));
    }

    return {
      result: { effects },
      intencionDetectada,
    };

  } catch (err) {
    if (err instanceof LLMUnavailableError) {
      logWarn(ctx.logCtx, "LLM no disponible, fallback a menú", { msg: err.message });
    } else {
      logError(ctx.logCtx, "error inesperado en LLM, fallback a menú", err);
    }
    // Señal para que el orchestrator muestre el menú
    return {
      result: { effects: [] },
      intencionDetectada: "__fallback_menu",
    };
  }
}
