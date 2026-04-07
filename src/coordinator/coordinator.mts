import type { TaskRecord } from "../types.mts"
import { TaskManager, type ManagedTaskContext } from "../tasks/task-manager.mts"

export class Coordinator {
  constructor(private readonly tasks: TaskManager) {}

  async run(
    goal: string,
    subtasks: string[],
    executePrompt: (prompt: string, context: ManagedTaskContext) => Promise<string>,
  ): Promise<{ summary: string; tasks: TaskRecord[] }> {
    const normalizedSubtasks = subtasks.length > 0
      ? subtasks
      : [
          `Understand the goal and define success criteria for: ${goal}`,
          `Collect the most relevant context for: ${goal}`,
          `Produce a concrete final answer for: ${goal}`,
        ]

    const results = await Promise.all(
      normalizedSubtasks.map(subtask =>
        this.tasks.run(subtask, context => executePrompt(subtask, context)),
      ),
    )

    const summary = results
      .map(result => `## ${result.label}\n${result.result ?? result.error ?? "(no output)"}`)
      .join("\n\n")

    return {
      summary,
      tasks: results,
    }
  }
}
