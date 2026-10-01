/**
 * One source of truth for "which model runs this task for this project"
 * (plan §5 model-per-task resolution): the stored project_models row wins,
 * the task registry's default is the fallback. Shared by the AI config
 * payload/test endpoint and by idea generation, so both always agree.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { projectModels } from "../db/schema";
import { TASKS } from "./tasks";

/** Effective model = stored project_models row ?? registry default. */
export async function effectiveModel(db: Db, projectId: string, taskKey: string): Promise<string> {
  const task = TASKS.find((t) => t.key === taskKey);
  if (!task) throw new Error(`task registry has no task "${taskKey}"`);
  const [row] = await db
    .select({ model: projectModels.model })
    .from(projectModels)
    .where(and(eq(projectModels.projectId, projectId), eq(projectModels.taskType, taskKey)))
    .limit(1);
  return row?.model ?? task.defaultModel;
}
