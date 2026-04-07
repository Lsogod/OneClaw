import { startInkUi } from "./react-app.tsx"

export async function startTextUi(): Promise<void> {
  await startInkUi(process.cwd())
}
