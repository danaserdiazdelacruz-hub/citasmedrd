// GET /api/proximas?dc_id=UUID&dias=7
import { Router } from "express";
import { z } from "zod";
import { rpc } from "../lib/supabase.js";
import { isValidUUID, toLocalTime, toLocalDate } from "../lib/dates.js";

export const proximasRouter = Router();

const DIAS_SEMANA = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
const MESES       = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

function etiquetaDia(isoUtc: string): string {
  const d = new Date(isoUtc);
  return `${DIAS_SEMANA[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`;
}

proximasRouter.get("/", async (req, res) => {
  const q = z.object({
    dc_id: z.string().refine(isValidUUID, "dc_id inválido"),
    dias:  z.coerce.number().int().min(1).max(30).default(7),
  }).parse(req.query);

  const hoy   = new Date().toLocaleDateString("en-CA");
  const hasta = new Date(Date.now() + q.dias * 86400000).toLocaleDateString("en-CA");

  const result = await rpc<any>("fn_citas_rango", {
    p_doctor_clinica_id: q.dc_id,
    p_desde:             hoy,
    p_hasta:             hasta,
  });

  if (result.status !== 200) {
    res.status(502).json({ error: "Error al obtener citas." });
    return;
  }

  const grupos: Record<string, any> = {};
  for (const c of result.data ?? []) {
    const fechaKey = toLocalDate(c.inicia_en);
    if (!grupos[fechaKey]) {
      grupos[fechaKey] = {
        fecha:    fechaKey,
        etiqueta: etiquetaDia(c.inicia_en),
        citas:    [],
      };
    }
    grupos[fechaKey].citas.push({
      id:                c.id,
      codigo:            c.codigo,
      hora_inicio:       toLocalTime(c.inicia_en),
      hora_fin:          toLocalTime(c.termina_en),
      estado:            c.estado,
      canal:             c.canal,
      motivo:            c.motivo,
      paciente_nombre:   c.paciente_nombre,
      paciente_telefono: c.paciente_telefono,
      servicio:          c.servicio_nombre,
      duracion_min:      c.duracion_min,
      duracion_texto:    `${c.duracion_min} min`,
    });
  }

  const diasArr = Object.values(grupos);
  const totalCitas = diasArr.reduce((a: number, g: any) => a + g.citas.length, 0);

  res.json({
    desde:       hoy,
    hasta,
    total_citas: totalCitas,
    total_dias:  diasArr.length,
    dias:        diasArr,
  });
});
