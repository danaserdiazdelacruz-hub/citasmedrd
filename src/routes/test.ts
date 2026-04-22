import { Router } from "express";
import { supabase } from "../lib/supabase.js";

export const testRouter = Router();

testRouter.get("/", async (_req, res) => {
  const sb = await supabase("GET", "/rest/v1/", null, { limit: "0" });
  const ok = sb.status === 200;
  res.json({
    estado: ok ? "OK" : "ERROR",
    supabase: ok,
    mensaje: ok ? "API funcionando correctamente." : "Error de conexión con Supabase.",
  });
});
