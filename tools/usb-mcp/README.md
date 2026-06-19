# Read-only USB serial MCP

Local-only MCP bridge for reading approved ESP32 serial firmware logs. It binds to loopback and can be exposed through an ngrok HTTPS endpoint for ChatGPT diagnostics. It cannot write to devices, flash firmware, expose a shell, or access arbitrary files.
