# Publicar o Multicorder - VideoMusic Maker na AWS

Este guia coloca o Multicorder na internet com **HTTPS**, usando o **S3** para guardar os arquivos e o **CloudFront** para entregá-los. É o jeito mais comum de publicar um site estático na AWS, e cada passo explica o que o serviço faz.

## Como funciona

```
Navegador do usuário ──HTTPS──▶ CloudFront (CDN, cópias perto do usuário) ──▶ S3 (bucket privado com os arquivos)
        │
        └─ grava, mixa e exporta no próprio navegador; projetos ficam no navegador de cada pessoa
```

- O Multicorder é **só arquivos estáticos** (HTML, JavaScript, CSS, ícones e os kits de bateria). Não há servidor nem banco de dados, e os vídeos de ninguém passam pela AWS.
- **S3** (Simple Storage Service): guarda os arquivos. O bucket é **privado**; só o CloudFront consegue ler.
- **CloudFront**: a CDN. Entrega os arquivos com HTTPS a partir do ponto mais perto do usuário (há pontos em São Paulo e no Rio), comprime o código e guarda cópias.
- **OAC** (Origin Access Control): a "chave" que deixa só o CloudFront ler o bucket.
- **CloudFormation**: cria tudo isso a partir de um arquivo de texto, o [`deploy/aws-site.yaml`](../deploy/aws-site.yaml). É "infraestrutura como código": dá para recriar ou apagar tudo de uma vez.
- **ACM** (Certificate Manager), opcional: o certificado HTTPS de um domínio próprio. Sem domínio, você usa um endereço `https://dxxxx.cloudfront.net` que já vem com HTTPS.

**Custo:** o site tem uns 50 MB. Com o **plano de preço fixo Free** do CloudFront (passo 4b), a entrega custa US$ 0 por mês e **não há cobrança de excedente**, mesmo que robôs baixem os arquivos sem parar. O S3 custa centavos. Mesmo assim, crie um alerta de gastos (passo 1).

---

## Passo 1. Conta e segurança

1. Crie a conta em [aws.amazon.com](https://aws.amazon.com/) (pede cartão de crédito).
2. Ative a **MFA** (verificação em duas etapas) no usuário raiz, a conta do e-mail de cadastro: menu da conta → *Security credentials* → *Assign MFA device*. Depois disso, use o usuário raiz o mínimo possível.
3. Crie um **alerta de gastos**: *Billing and Cost Management* → *Budgets* → *Create budget* → modelo *Zero spend budget* (avisa por e-mail quando qualquer cobrança aparecer) ou *Monthly cost budget* com, por exemplo, US$ 5.
4. Crie um usuário para o dia a dia pelo **IAM Identity Center** (o jeito recomendado hoje):
   - console → *IAM Identity Center* → *Enable*;
   - *Users* → *Add user* (seu nome e e-mail) → confirme o convite que chega no e-mail;
   - *AWS accounts* → marque a sua conta → *Assign users or groups* → escolha o usuário e o *permission set* **AdministratorAccess** (para aprender; depois dá para restringir);
   - anote a **AWS access portal URL** que aparece no painel (algo como `https://d-xxxxxxxxxx.awsapps.com/start`).

## Passo 2. Instalar e configurar o AWS CLI

O AWS CLI é o programa de linha de comando da AWS, e o script de publicação usa ele.

1. No PowerShell:

   ```bash
   winget install Amazon.AWSCLI
   ```

   Feche e abra o terminal de novo.
2. Ligue o CLI ao usuário do Identity Center:

   ```bash
   aws configure sso
   ```

   Responda com a *access portal URL* do passo 1, a região `us-east-1` para o SSO, escolha a conta e o *permission set*. Em **CLI default client Region**, use `sa-east-1` (São Paulo). Em **profile name**, use `default`.
3. Teste:

   ```bash
   aws sts get-caller-identity
   ```

   Deve mostrar o número da sua conta. Quando o login expirar (algumas horas), rode `aws sso login`.

## Passo 3. Criar a infraestrutura (uma vez só)

Na pasta do projeto:

```bash
aws cloudformation deploy --stack-name multicorder --template-file deploy/aws-site.yaml --region sa-east-1
```

- Leva de 5 a 10 minutos, porque o CloudFront precisa se espalhar pelo mundo.
- Para acompanhar, abra *CloudFormation* → *Stacks* → **multicorder** → aba *Events*.
- Para ver o que foi criado, use a aba *Resources*. O endereço do site fica em *Outputs* → **SiteUrl**.

Também dá para fazer pelo console: *CloudFormation* → *Create stack* → *Upload a template file* → escolha o `deploy/aws-site.yaml`.

## Passo 4. Publicar o app

```bash
powershell -ExecutionPolicy Bypass -File deploy\publicar-aws.ps1
```

O script:
1. lê na stack o nome do bucket e da distribuição;
2. envia **só os arquivos do app** (`index.html`, `styles.css`, `manifest.webmanifest`, `src/`, `icons/` e `kits/`). Docs, `.git`, `serve.py` e o `iniciar.bat` ficam de fora;
3. grava em cada arquivo o **tipo** e o **cache** certos (tabela abaixo);
4. limpa o cache do CloudFront, para a versão nova aparecer na hora;
5. mostra o endereço. Abra no Chrome, no Edge ou no Firefox.

**Tipos de arquivo e cache:**

| Arquivos | Tipo (Content-Type) | Cache no navegador | Cache na CDN |
|---|---|---|---|
| `index.html` | `text/html` | guarda e confere se mudou (`max-age=0, must-revalidate`) | até a próxima publicação |
| `src/**/*.js` | `text/javascript` | idem | idem |
| `styles.css`, `manifest.webmanifest` | `text/css`, `application/manifest+json` | idem | idem |
| `kits/` (48 MB), `icons/` | `application/octet-stream`, `application/json`, `image/png`… | 1 dia sem conferir (`max-age=86400`) | até a próxima publicação |

"Conferir se mudou" é uma pergunta curta: se nada mudou, a resposta é "304 Not Modified", sem baixar o arquivo de novo. Assim, quem volta ao app não baixa nada outra vez, e quem abre depois de uma publicação recebe a versão nova.

O tipo de arquivo vai fixo no script porque o Windows às vezes registra `.js` como `text/plain`, e o navegador se recusa a rodar módulos JavaScript com esse tipo.

**Para atualizar depois:** rode o mesmo comando. Ele só envia o que mudou. Se você mudar as regras de tipo ou de cache no script, use `-Forcar` para reenviar tudo.

## Passo 4b. Proteção contra robôs e cobranças: plano de preço fixo Free

Sem proteção, um robô pode pedir os arquivos (os kits de bateria têm ~13 MB cada) milhares de vezes, e o CloudFront cobraria o tráfego. O **plano de preço fixo Free** do CloudFront resolve:
- **US$ 0 por mês**, com 1 milhão de pedidos e 100 GB por mês;
- **sem cobrança de excedente**: se o uso passar muito do limite por meses seguidos, a AWS pode deixar a entrega mais lenta, mas não cobra;
- já inclui o **AWS WAF** (firewall) e a proteção contra ataques de negação de serviço. Pedidos bloqueados não contam no limite;
- avisa por e-mail em 50%, 80% e 100% do uso.

**Pré-requisitos** (o modelo `deploy/aws-site.yaml` já atende):
- a conta precisa estar no **plano pago** da AWS. Contas no "Free plan" (com créditos) não podem usar planos fixos, mas também nunca são cobradas;
- a distribuição usa só as regras **prontas** da AWS: **CachingOptimized** (cache) e **SecurityHeadersPolicy** (cabeçalhos). O plano Free não aceita regras próprias.

**Como ativar (console):**
1. **CloudFront** → **Distributions** → a sua distribuição.
2. Escolha o **plano de preços** (*pricing plan*) **Free** e siga os passos de atualização.
3. Quando pedir, crie o **Web ACL do AWS WAF** com as regras padrão. Ele é obrigatório enquanto o plano estiver ativo.
4. Espere a distribuição sair de *Deploying* (alguns minutos).

**Atenção:** o plano e o WAF ficam fora do CloudFormation. Depois de ativar, **não rode o `cloudformation deploy` de novo** sem antes incluir o WAF no modelo, porque a atualização tiraria o WAF da distribuição. Para publicar versões do app, use só o `publicar-aws.ps1`, que não mexe nisso.

**Para voltar ao preço por uso:** cancele o plano na mesma tela. Para apagar a distribuição, é preciso cancelar o plano antes.

## Passo 5 (opcional). Domínio próprio

Por exemplo, `app.seudominio.com.br`:

1. **Certificado:** no console, troque a região para **us-east-1 (N. Virginia)**, porque o CloudFront só usa certificados de lá. Depois: *Certificate Manager* → *Request* → *Request a public certificate* → o seu domínio → validação por **DNS**.
2. No painel do seu domínio (Registro.br, Cloudflare, Route 53…), crie o **CNAME** que o ACM mostra. Espere o status virar *Issued*.
3. Atualize a stack com o domínio e o ARN do certificado:

   ```bash
   aws cloudformation deploy --stack-name multicorder --template-file deploy/aws-site.yaml --region sa-east-1 --parameter-overrides DomainName=app.seudominio.com.br CertificateArn=arn:aws:acm:us-east-1:...
   ```

4. No painel do domínio, crie um **CNAME** de `app` para o **CloudFrontDomain** que aparece nos *Outputs* da stack (`dxxxx.cloudfront.net`).

## Os projetos de cada pessoa

Os projetos ficam guardados no navegador de cada usuário, separados por endereço. Os projetos que você tem em `http://localhost:8080` **não aparecem** no site da AWS. Para levar um projeto:
1. no localhost, use **Salvar arquivo** (gera o `.mcproj`);
2. no site novo, use **Importar arquivo .mcproj**.

O app pede ao navegador "armazenamento persistente", para os projetos não serem apagados quando o disco enche. Mesmo assim, o `.mcproj` é o backup de verdade.

## Problemas comuns

- **Página "AccessDenied" (XML)**: o arquivo não existe no bucket. Confira se o script terminou sem erro e se o endereço está certo. Logo depois de criar a stack, espere uns minutos.
- **Abre a versão antiga**: espere a limpeza do cache (1 a 2 minutos) e recarregue com **Ctrl+F5**.
- **Câmera ou microfone bloqueados**: o endereço precisa começar com `https://`. Clique no cadeado da barra de endereço e libere as permissões.
- **`aws` não é reconhecido**: feche e abra o terminal depois de instalar o CLI.
- **`The SSO session ... has expired`**: rode `aws sso login`.

## Apagar tudo

1. Esvazie o bucket (o nome está nos *Outputs*):

   ```bash
   aws s3 rm s3://NOME-DO-BUCKET --recursive
   ```

2. Se o plano de preço fixo estiver ativo, cancele o plano na distribuição (CloudFront → Distributions → a distribuição).
3. Apague a stack, que remove o CloudFront, o bucket e as políticas:

   ```bash
   aws cloudformation delete-stack --stack-name multicorder --region sa-east-1
   ```

## Próximos passos para aprender

- **Publicar sozinho a cada `git push`**: um workflow do GitHub Actions, com login na AWS por **OIDC** (sem guardar chaves no GitHub), roda o mesmo envio do script.
- **Ver o tráfego**: *CloudFront* → *Reports & analytics*.
- **Restringir permissões**: trocar o *AdministratorAccess* por uma política só com S3 e CloudFront.
