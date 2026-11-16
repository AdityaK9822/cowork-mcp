/** A model-facing tool failure: the message is safe to show, any cause stays internal. */
export class ToolFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}
