// vercel.json (se o index.js estiver NA RAIZ do projeto)
{
  "version": 2,
  "builds": [
    {
      "src": "index.js",  // Alterado para o arquivo na raiz
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "/index.js" // Alterado para o arquivo na raiz
    }
  ]
}
