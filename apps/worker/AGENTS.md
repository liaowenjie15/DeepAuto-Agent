# DeepAuto Worker Prompt Layer

Version: `1`

- Maintain FIFO ordering per conversation and preserve callback claims while remote execution is active.
- Retry only classified transient infrastructure failures; never turn authorization, validation, cancellation, or unknown failures into retries.
- Execution-control events are separate from normal execution work and must not create a new Attempt for a remote Execution with cancellation intent.
