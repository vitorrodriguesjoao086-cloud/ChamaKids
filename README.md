# ChamaKids

A professora toca no número da criança no celular e a equipe de comunicação recebe uma notificação discreta, sem som, no canto inferior direito do computador. A ativação no telão continua manual.

## Como funciona

- **App das professoras** (`/`): grade de 0 a 100. Toca no número, aparece "Chamar o número X?" com os botões Voltar e Chamar.
- **Painel da comunicação** (`/painel`): página aberta no computador, sem login. É um painel somente de exibição: recebe chamados em tempo real, mostra o número como notificação e como alerta no canto inferior direito. Um novo chamado substitui o anterior. Sem som, sem fila, sem botão de atendido.
- **App das professoras** (`/`) e administração (`/admin`): continuam protegidos por autenticação; somente contas aprovadas podem chamar e apenas o administrador gerencia acessos.
- Se nenhum computador estiver conectado no momento do chamado, a professora recebe um aviso para falar com a equipe pessoalmente.

## Configurar administrador

Configure o administrador antes de iniciar. No PowerShell:

```powershell
$env:ADMIN_NAME = "Nome completo do administrador"
$env:ADMIN_PASSWORD = "uma-senha-forte-com-pelo-menos-12-caracteres"
node server.js
```

O nome e a senha do administrador são provisionados pelo servidor; a senha é guardada somente como hash. Não use uma senha compartilhada nem publique essas variáveis.

Abra `http://localhost:3000/`, solicite acesso com outro nome e aprove a solicitação em `/admin`, usando a conta do administrador.

## Acessos e armazenamento

- O primeiro acesso de cada pessoa cria uma solicitação pendente. Só o administrador configurado em `ADMIN_NAME` pode aprovar, recusar ou revogar acessos.
- No painel `/admin`, novas solicitações aparecem automaticamente. É possível ativar notificações do navegador; para recebê-las, mantenha o painel aberto.
- Senhas de usuários são derivadas com `scrypt`. As sessões usam cookies HttpOnly e podem ser encerradas ou revogadas pelo administrador.
- Sem Upstash, usuários e sessões ficam em `DATA_DIR` (por padrão, `data/`). Em hospedagem, configure esse diretório em um disco persistente para não perder os cadastros ao reiniciar.
- Opcionalmente, configure `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` para armazenar os dados e o segredo de sessão no Upstash. Se `SESSION_SECRET` for definido, use um valor aleatório de pelo menos 32 caracteres e mantenha-o estável.

No Render, defina `ADMIN_NAME` e `ADMIN_PASSWORD` em **Environment**. Para persistência, use um disco montado no caminho configurado em `DATA_DIR` ou configure as duas variáveis do Upstash.

## Testar no seu computador

Com o servidor ativo, abra `http://localhost:3000/painel` no computador receptor (não é necessário entrar). Em outro aparelho ou navegador, entre em `http://localhost:3000/` com uma conta aprovada, toque em um número e em Chamar.

## Colocar no ar (grátis) com Render

O PWA só pode ser instalado no celular com HTTPS, e o Render já entrega isso.

1. Crie um repositório no GitHub e envie estes arquivos.
2. Em render.com, crie um **Web Service** ligado ao repositório.
3. Runtime: **Node**. Build Command: deixe vazio. Start Command: `node server.js`.
4. Configure as variáveis de ambiente do administrador e o armazenamento persistente conforme a seção anterior.
5. Quando terminar, você recebe um endereço como `https://chamakids.onrender.com`.

Observação: no plano grátis o Render "dorme" depois de um tempo sem uso e a primeira abertura pode demorar cerca de um minuto. Abra o painel alguns minutos antes do culto para acordar o servidor.

## Instalar nos aparelhos

- **Professoras (Android):** abrir o endereço no Chrome, menu (três pontos), "Instalar app" ou "Adicionar à tela inicial".
- **Professoras (iPhone):** abrir no Safari, botão Compartilhar, "Adicionar à Tela de Início".
- **Comunicação:** abrir `/endereço/painel` no Chrome ou Edge sem fazer login, clicar em "Ativar notificações" e permitir. Deixar a aba aberta (pode ficar minimizada). Esse painel só recebe e exibe chamados; não permite chamar nem gerenciar contas.

## Dica para o computador da comunicação

No Windows, verifique se o modo "Não perturbe" / "Assistente de foco" está desligado, senão as notificações do sistema ficam escondidas. O alerta dentro da página funciona de qualquer forma.

## Arquivos

- `server.js`: servidor (sem dependências, só Node 18+)
- `public/index.html`: app das professoras
- `public/painel.html`: painel da comunicação
- `public/sw.js`, `public/manifest.webmanifest`, `public/icon-*.png`: instalação como app
