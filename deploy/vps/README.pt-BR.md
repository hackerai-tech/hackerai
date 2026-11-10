# HackerAI Brasil na VPS — tandi.tech

Este pacote modifica o código do ZIP enviado. Ele acrescenta um perfil de hospedagem própria para Ubuntu 24.04: Next.js, Convex, Ollama, Redis, RustFS (armazenamento S3), Centrifugo e um contêiner separado para as ferramentas do agente. O Caddy solicita e renova o certificado HTTPS automaticamente.

## Estado da entrega

Preparação e testes locais; o usuário iniciou a instalação pelo terminal da Hostinger. A aceitação completa na VPS permanece pendente. O instalador completo, a emissão real do certificado, a inferência do Ollama e uma tarefa completa do agente no servidor ainda precisam de validação. Não trate os testes parciais como comprovação de que todo o sistema está pronto em produção.

A interface principal recebeu traduções para português do Brasil e o modelo recebe instruções para responder nesse idioma. A revisão de todos os textos e telas do projeto original permanece pendente.

## Recursos

- Mínimo verificado pelo instalador: aproximadamente 8 GB de RAM e 30 GB de disco livre. Recomendado para começar: 16 GB de RAM, 4 vCPUs e 40 GB livres.
- Modelo inicial: `qwen2.5:3b`, via Ollama, com CPU. Um modelo pequeno tem capacidade limitada em tarefas complexas e uso de ferramentas; a qualidade precisa ser avaliada na sua VPS.
- Sem tarifa de API ou cota diária de mensagens. A capacidade continua limitada pelo hardware, por uma geração simultânea, pelo contexto do modelo e pelos limites de duração do agente.
- O perfil atual usa uma conta administradora local. Não há cadastro público ou integração WorkOS.
- DNS A e, se existir, AAAA devem apontar para a VPS correta. Portas TCP 80/443 precisam estar acessíveis no provedor. O acesso SSH deve continuar permitido.

## Instalar pelo terminal da Hostinger

No terminal da VPS, conectado como root, use a branch preparada no próprio repositório:

```bash
apt-get update && apt-get install -y git
git clone --branch codex/vps-tandi --single-branch --depth 1 https://github.com/tandicell/hackeraiBR.git /opt/hackeraiBR && cd /opt/hackeraiBR && bash deploy/vps/install.sh
```

O primeiro comando prepara o Git. O segundo baixa a adaptação e inicia o instalador. Se `/opt/hackeraiBR` já existir, interrompa e confira seu conteúdo antes de continuar; não apague uma instalação existente. O instalador solicitará um e-mail e uma senha nova para entrar no aplicativo. Ele não precisa receber a senha SSH.

As diferenças em relação à versão original e os testes ainda pendentes estão detalhados abaixo. Publicar esta branch não comprova que a VPS foi instalada.

## Instalar por SSH

Envie `hackeraiBR-tandi-vps.zip` para `/tmp` usando SFTP ou `scp`. FTP comum apenas transfere arquivos e não instala os serviços.

No seu computador, substitua o IP e o usuário pelos dados corretos:

```bash
scp hackeraiBR-tandi-vps.zip usuario@IP_DA_VPS:/tmp/
ssh usuario@IP_DA_VPS
```

Na VPS Ubuntu 24.04:

```bash
sudo apt-get update
sudo apt-get install -y unzip
sudo unzip /tmp/hackeraiBR-tandi-vps.zip -d /opt
cd /opt/hackeraiBR-tandi-vps
sudo bash deploy/vps/install.sh
```

Informe o e-mail e a senha no terminal da VPS. A configuração guarda um hash scrypt da senha e gera as chaves RSA e as credenciais dos serviços. Não envie senha ou chave privada pelo chat. Os arquivos privados ficam em `deploy/vps/private/` e `deploy/vps/.env`.

O instalador não formata o servidor nem apaga volumes existentes. Ele recusa uma primeira instalação se as portas 80/443 estiverem ocupadas. Instala Docker pelo APT do Ubuntu, compila as imagens, publica as funções do Convex, prepara o armazenamento privado e baixa o modelo. O primeiro build e o download do modelo podem demorar. Depois de configurar o e-mail e a senha, o instalador inicia a compilação em segundo plano e informa onde acompanhar o log. A configuração privada existente é reaproveitada nas tentativas seguintes.

Depois, acesse `https://tandi.tech/local-login`. O certificado depende da resolução DNS e do acesso externo às portas 80/443; apenas iniciar os contêineres não comprova HTTPS funcionando.

## Retomar após desconexão do terminal

Na instalação clonada em `/opt/hackeraiBR`, execute como root:

```bash
cd /opt/hackeraiBR && git pull --ff-only && bash deploy/vps/resume.sh
```

Acompanhe sem depender da sessão original:

```bash
tail -n 60 /opt/hackeraiBR/deploy/vps/private/install.log
```

A senha já definida fica no arquivo privado `.env`; a retomada não a solicita novamente. Se esse arquivo ainda não existir, execute `bash deploy/vps/install.sh` no terminal para configurá-lo primeiro. Não compartilhe o conteúdo de `.env`.

O processo ignora o encerramento normal da sessão SSH e grava saída em `deploy/vps/private/install.log`. Isso não garante continuidade após reinício da própria VPS. O instalador usa um bloqueio para evitar execuções simultâneas. Se uma instalação anterior continuar ativa, a retomada avisa e preserva essa execução.

O sandbox agora recebe um pacote independente com dependências de produção e lockfile próprio, em vez de empacotar novamente o workspace inteiro com `pnpm deploy`. No teste Linux/Node 22, essa instalação adicionou 23 pacotes e executou uma PTY real com usuário sem privilégios. A preparação, o build web e o build do sandbox são executados em sequência para reduzir a carga simultânea.

## Operação

Execute os comandos seguintes na pasta `deploy/vps` do pacote instalado:

```bash
cd /opt/hackeraiBR-tandi-vps/deploy/vps
sudo docker compose ps
sudo docker compose logs --tail=100 web backend sandbox caddy
```

Não compartilhe logs completos ou `docker inspect` sem revisar possíveis dados privados.

Alterar a senha:

```bash
cd /opt/hackeraiBR-tandi-vps
sudo python3 deploy/vps/change-password.py
sudo docker compose --env-file deploy/vps/.env -f deploy/vps/compose.yaml up -d --force-recreate web
```

A troca de senha invalida as sessões verificadas pelo aplicativo. Tokens já entregues ao Convex podem permanecer válidos por até cinco minutos. Sair da conta remove o cookie do navegador; não há cadastro multiusuário ou painel de revogação de sessões nesta versão.

Reiniciar o sandbox após uma desconexão:

```bash
cd /opt/hackeraiBR-tandi-vps/deploy/vps
sudo docker compose restart sandbox
```

O cliente original encerra por inatividade; a política de reinício do contêiner o reconecta. Não regenere o token na interface sem atualizar a credencial do contêiner: execute novamente `bootstrap.mjs sandbox` pelo serviço `tools` e recrie `sandbox`.

## Agentes e diferenças do perfil local

O perfil reutiliza a interface e as ferramentas do projeto, e encaminha o modo Agente ao mesmo executor de streaming usado pelo chat. As ferramentas recebem o ambiente local conectado pelo Centrifugo. O contêiner de ferramentas não recebe o socket Docker, as chaves de login, as credenciais do banco ou volumes da VPS anfitriã.

Este perfil executa comandos com acesso completo dentro do sandbox. Os modos de aprovação por ação e revisão automática, o modo de metas, agendamento e a continuidade durável do Trigger.dev não estão implementados neste perfil. As opções incompatíveis foram ocultadas ou bloqueadas. Interromper ou reiniciar o processo pode encerrar a tarefa; o perfil não promete retomar uma execução após reinício da VPS. O histórico já gravado fica nos volumes locais.

O sandbox inicial inclui shell, Python, Git, curl, nmap e utilitários comuns. Ele não inclui a imagem Kali completa original ou um navegador gráfico. Recursos que dependem de navegador, visão, serviços externos, pagamento ou equipe não têm paridade comprovada. Pesquisa Perplexity e leitura Jina permanecem opcionais e desativadas sem chaves.

O modelo padrão é textual. Não há compreensão de imagens comprovada. O contexto do Ollama foi configurado em 16.384 tokens e o histórico do aplicativo em 8.192 tokens para reservar espaço às instruções, ferramentas e resposta. O agente mantém limites operacionais do projeto, incluindo duração por execução; “sem cota diária” não significa contexto ou execução infinitos.

## Aceitação na VPS

1. Acesse a página por HTTPS, confira o domínio e faça login; uma senha incorreta deve ser rejeitada.
2. Envie uma pergunta simples em português no modo Perguntar. Confira a resposta, recarregue e verifique o histórico.
3. Aguarde a conexão `Sandbox VPS`, selecione esse ambiente e peça ao agente para executar `pwd` e criar um arquivo de teste no próprio sandbox. Confira a saída real e o arquivo.
4. Interrompa uma resposta e envie outra. Reinicie apenas o sandbox e confirme a reconexão. Reinicie o aplicativo e confira o histórico já salvo.
5. Teste envio e download de um arquivo textual. Confira que o acesso sem assinatura ao armazenamento é negado.
6. Confira o espaço livre, RAM, CPU e logs após uma tarefa. Ajuste o modelo somente depois de medir o uso.

## Parar e recuperar

```bash
cd /opt/hackeraiBR-tandi-vps/deploy/vps
sudo docker compose down
sudo docker compose up -d
```

`down` preserva os volumes. **Não acrescente `-v`** se quiser manter dados. Faça snapshot da VPS ou cópia consistente dos volumes e da configuração privada antes de atualizar. Não restaure apenas o código se uma atualização futura também alterar o esquema do banco.

## Recibo de entrega

- **O que mudou:** perfil local com autenticação própria, Ollama, infraestrutura e adaptações de interface; as diferenças de agentes estão descritas acima.
- **Prévia/testes:** build de produção e checagem de tipos; testes locais de autenticação e encaminhamento; publicação das funções e do esquema em Convex local; envio e leitura privados em RustFS; HTTP de login com Redis e recuperação após reinício. VPS/HTTPS/Ollama/agente completo: pendentes.
- **Recuperação testada:** rejeição de senha incorreta, token adulterado/expirado e sessão anterior à troca de senha. Redis indisponível devolveu 503 e voltou a aceitar verificações após reinício. O lançador foi testado em Linux para ausência de configuração, execução em segundo plano, SIGHUP, bloqueio de duplicidade, log e nova tentativa após conclusão; APT/Docker e a identificação Ubuntu foram fronteiras simuladas nesse teste. Reinício e retomada completos na VPS: pendentes.
- **Custo/impacto esperado:** elimina dependência de API de LLM no perfil local; recursos e tráfego da VPS continuam limitados e cobrados pelo provedor.
- **Reversão:** parar com `docker compose down`, preservar os volumes e restaurar o snapshot anterior. A preparação na VPS foi iniciada pelo usuário; o estado dos serviços ainda precisa ser confirmado.
