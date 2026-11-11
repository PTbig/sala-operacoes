# Sala de Operações

App web de coordenação de ocorrências para corpos de bombeiros: ocorrências no mapa com fotos e registo cronológico, meios e tripulações, chat com prioridades (com alerta de Emergência para todos) e contas com quatro postos: Bombeiro, Chefe, Comando e Central.

Não tem dependências externas. Precisa de **Node.js 22.13 ou superior** (usa o SQLite incluído no Node). Os dados ficam numa única pasta (`data/`): a base de dados `sala.db` e as fotos.

## Instalação com Docker (recomendada)

Num servidor Linux com Docker e um domínio a apontar para ele (ex. `sala.bvexemplo.pt`):

```bash
cp .env.example .env
nano .env            # defina ADMIN_PASSWORD e, se tiver, GOOGLE_MAPS_API_KEY
nano Caddyfile       # troque sala.exemplo.pt pelo seu domínio
docker compose up -d --build
```

O Caddy obtém e renova sozinho o certificado HTTPS. Abra `https://o-seu-dominio` no browser.

**HTTPS é obrigatório**: sem ele, o telemóvel não dá a localização GPS e o login não funciona (os cookies são só HTTPS).

Se o servidor já tiver nginx ou outro proxy, retire o serviço `caddy` do `docker-compose.yml` e aponte o proxy para `127.0.0.1:8080`. No nginx, para o tempo real funcionar, desligue o buffering no `location /api/eventos` (`proxy_buffering off; proxy_read_timeout 1h;`) e aumente `client_max_body_size` para 15m por causa das fotos.

## Instalação sem Docker

```bash
cp .env.example .env && nano .env
npm start
```

Para manter a correr após reinício, use systemd ou pm2. Para testar só no próprio computador em `http://localhost:8080`, ponha `COOKIE_SECURE=false` no `.env`.

## Primeiro acesso

- Utilizador: `central` (ou o definido em `ADMIN_USER`).
- Palavra-passe: a que pôs em `ADMIN_PASSWORD`. Se deixou vazio, foi gerada uma aleatória e aparece nos logs: `docker compose logs sala`.
- No primeiro login a app obriga a definir uma palavra-passe nova.

A conta inicial só é criada quando a base de dados está vazia. Mudar `ADMIN_PASSWORD` depois não altera nada.

Depois de entrar:

1. Em **Configuração**, ponha o nome da corporação, ajuste os tipos de ocorrência e de veículo, e guarde a vista inicial do mapa sobre a vossa área.
2. Em **Elementos**, crie as contas. A app gera uma palavra-passe temporária que entrega ao elemento; ele define a sua no primeiro login.
3. Em **Meios**, adicione os veículos e distribua as tripulações.

No telemóvel, use "Adicionar ao ecrã principal" no menu do browser para abrir a app como se fosse instalada.

## Google Maps

1. Em https://console.cloud.google.com crie um projeto e ative a **Maps JavaScript API** (exige conta de faturação; o uso de uma corporação fica normalmente dentro da quota gratuita mensal).
2. Crie uma chave de API e **restrinja-a** a "Sites" com o seu domínio (`https://sala.bvexemplo.pt/*`) e à Maps JavaScript API.
3. Ponha a chave em `GOOGLE_MAPS_API_KEY` no `.env` e reinicie (`docker compose up -d`).

Sem chave, a app usa OpenStreetMap, que também mostra ruas e funciona sem conta.

## Postos e permissões

As permissões são verificadas no servidor.

| Posto | Pode |
|---|---|
| Bombeiro | Ver tudo, adicionar notas e fotos, chat (todas as prioridades), alterar o seu estado |
| Chefe | + registar e editar ocorrências, estado e prioridade, n.º SADO, atribuir meios, gerir tripulações |
| Comando | + criar e remover veículos, eliminar ocorrências, gerir contas de Bombeiros e Chefes |
| Central | Tudo, incluindo contas de Comando e Central e a configuração |

Qualquer elemento pode enviar uma mensagem de Emergência: aparece um alerta vermelho, com som e vibração, no ecrã de todos.

## Cópias de segurança

Copie a pasta `data/` com regularidade. Com a app a correr, para uma cópia consistente da base de dados:

```bash
sqlite3 data/sala.db ".backup data/backup-$(date +%F).db"
```

## Segurança

Palavras-passe guardadas com scrypt, sessões em cookie HttpOnly/Secure/SameSite=Strict, bloqueio de 15 minutos após 8 tentativas de login falhadas, verificação do tipo real das imagens, fotos só acessíveis com sessão iniciada, cabeçalhos CSP. Desativar uma conta termina de imediato as suas sessões.

## Nota operacional

Esta app complementa, não substitui, a rádio SIRESP nem os procedimentos e sistemas oficiais (CDOS, SADO). Se a rede móvel falhar, a rádio continua a ser o canal principal.
