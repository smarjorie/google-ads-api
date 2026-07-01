export default function Home() {
  return (
    <main style={{ maxWidth: 640, margin: "80px auto", padding: "0 20px", lineHeight: 1.6 }}>
      <h1>🚀 Google Ads MCP Server</h1>
      <p>Este servidor está no ar.</p>
      <p>
        Endpoint MCP (streamable HTTP): <code>/mcp</code>
        <br />
        Endpoint MCP (SSE, clientes legados): <code>/sse</code>
      </p>
      <p>
        Configure este servidor no seu agente apontando para a URL completa, por exemplo:
        <br />
        <code>https://SEU-DOMINIO.vercel.app/mcp</code>
      </p>
    </main>
  );
}
