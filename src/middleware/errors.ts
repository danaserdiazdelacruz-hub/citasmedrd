// ================================================================
// errors.ts — Manejador global de errores.
// Captura cualquier excepción no manejada y devuelve JSON limpio.
// ================================================================
import { Request, Response, NextFunction } from "express";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  console.error("[ERROR]", err);

  // Error de Zod (validación)
  if (err && typeof err === "object" && "issues" in err) {
    const issues = (err as { issues: { path: string[]; message: string }[] }).issues;
    res.status(400).json({
      error: "Datos inválidos.",
      detalle: issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }

  res.status(500).json({
    error: "Error interno del servidor. Intenta de nuevo.",
  });
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: "Ruta no encontrada." });
}
