export const metadata = {
  title: "Google Ads MCP",
  description: "Servidor MCP para gestão de contas Google Ads de clientes",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  );
}
