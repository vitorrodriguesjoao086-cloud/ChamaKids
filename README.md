# ChamaKids

A professora toca no número da criança no celular e a equipe de comunicação recebe uma notificação discreta, sem som, no canto inferior direito do computador. A ativação no telão continua manual.

## Como funciona

- **App das professoras** (`/`): grade de 0 a 100. Toca no número, aparece "Chamar o número X?" com os botões Voltar e Chamar.
- **Painel da comunicação** (`/painel`): página aberta no computador. Mostra o número como notificação e como alerta no canto inferior direito. Um novo chamado substitui o anterior. Sem som, sem fila, sem botão de atendido.
- Se nenhum computador estiver conectado no momento do chamado, a professora recebe um aviso para falar com a equipe pessoalmente.

## Testar no seu computador

```
node server.js
```

Abra `http://localhost:3000/painel` em uma aba e `http://localhost:3000/` em outra. Toque em um número e em Chamar.

## Colocar no ar (grátis) com Render

O PWA só pode ser instalado no celular com HTTPS, e o Render já entrega isso.

1. Crie um repositório no GitHub e envie estes arquivos.
2. Em render.com, crie um **Web Service** ligado ao repositório.
3. Runtime: **Node**. Build Command: deixe vazio. Start Command: `node server.js`.
4. Quando terminar, você recebe um endereço como `https://chamakids.onrender.com`.

Observação: no plano grátis o Render "dorme" depois de um tempo sem uso e a primeira abertura pode demorar cerca de um minuto. Abra o painel alguns minutos antes do culto para acordar o servidor.

## Instalar nos aparelhos

- **Professoras (Android):** abrir o endereço no Chrome, menu (três pontos), "Instalar app" ou "Adicionar à tela inicial".
- **Professoras (iPhone):** abrir no Safari, botão Compartilhar, "Adicionar à Tela de Início".
- **Comunicação:** abrir `/endereço/painel` no Chrome ou Edge, clicar em "Ativar notificações" e permitir. Deixar a aba aberta (pode ficar minimizada).

## Dica para o computador da comunicação

No Windows, verifique se o modo "Não perturbe" / "Assistente de foco" está desligado, senão as notificações do sistema ficam escondidas. O alerta dentro da página funciona de qualquer forma.

## Arquivos

- `server.js`: servidor (sem dependências, só Node 18+)
- `public/index.html`: app das professoras
- `public/painel.html`: painel da comunicação
- `public/sw.js`, `public/manifest.webmanifest`, `public/icon-*.png`: instalação como app
