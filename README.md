# Pingger

Ferramenta de diagnóstico de rede por traceroute contínuo, escrita do zero em Python
(só biblioteca padrão, sem dependências) com interface web local.

## Download (versão portátil)

[![Baixar Pingger.exe](https://img.shields.io/badge/Baixar-Pingger.exe-2ea44f?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/brunokdalcastel/pingger/releases/latest/download/Pingger.exe)

Baixe o **`Pingger.exe`** na [última release](../../releases/latest) e dê duplo-clique, sem
instalar nada e sem precisar de Python. Os dados ficam em `PinggerData\`, ao lado do exe
(se a pasta não aceitar escrita, vão para `%LOCALAPPDATA%\Pingger`). Dá para levar num pendrive.

Para gerar o exe: `.\build.ps1` → `dist\Pingger.exe`.

## Como abrir

- **Duplo-clique em `Pingger.pyw`**: abre a janela (Edge/Chrome em modo app), sem console.
- Pelo terminal:
  ```
  python -m pingger                         # abre a interface
  python -m pingger --trace 8.8.8.8 meu.site  # já começa a tracear
  python -m pingger --no-browser --bind 0.0.0.0   # modo servidor / agente remoto
  ```
- Dados (banco SQLite, sons, logs): `%LOCALAPPDATA%\Pingger` (altere com `--data`).
- Painel: http://127.0.0.1:7465/

## Funcionalidades

| Área | O que tem |
|---|---|
| Trace | ICMP por hop (API `iphlpapi` do Windows, sem admin), IPv4 e IPv6, rota completa / só destino / um hop específico, TCP e UDP (só destino), intervalo de 0,5 s a 1 h, tamanho de pacote, timeout, máx. de hops, TOS/DSCP, bit DF (descoberta de MTU), DNS reverso |
| Grade | Hop, contagem, IP, nome, média/mín/atual/máx, perda %, jitter, MOS e gráfico de latência por hop (faixa mín–máx, média, atual e perda) |
| Linha do tempo | Gráfico do destino + timelines fixáveis por hop, períodos de 1 min a 7 dias, navegação no histórico (◀ ▶, roda do mouse), foco por arrastar, marcas de mudança de rota, gráfico de jitter com linha-alvo, escala de latência e de perda configuráveis |
| Vários alvos | Quantos quiser em paralelo; vários de uma vez separados por espaço |
| Resumos | Painéis com o destino de vários alvos e mini-timelines |
| Workspaces | Conjuntos nomeados de alvos e resumos; trocar, salvar e excluir |
| Alertas | Condições: latência/perda em N de M amostras, perda média, latência média, jitter, MOS, destino inalcançável, mudança de rota; por hop ou destino; alvos específicos, todos ou faixa CIDR. Notificar ao começar, terminar, ambos ou enquanto durar, com repetição |
| Ações de alerta | Som, notificação na área de trabalho, e-mail SMTP, log em arquivo, executar programa, webhook REST, salvar sessão .pgr, adicionar/remover de um resumo, mudar o modo do trace. Variáveis `$host $ip $latency $loss $mos $route`… |
| Dados | Gravação automática em SQLite, retenção configurável, sessões salvas (abrir histórico ou retomar), exportar CSV (longo/largo), exportar/importar sessão `.pgr`, importar/exportar lista de alvos, exportação automática periódica |
| Imagens/texto | Salvar PNG, copiar imagem, copiar estatísticas como texto |
| Ferramentas | Whois/bloco IP (RDAP), consulta DNS, copiar IP/nome, criar alvo a partir de um hop |
| Remoto | Painel web acessível pela rede com senha; **agente remoto**: um Pingger pode tracear a partir de outra máquina com Pingger (motor “Via agente remoto”) |
| Outros | Configurações nomeadas (presets), tema claro/escuro, favicon vermelho com alerta ativo, linha de comando |

## Limitações conhecidas

- TCP/UDP medem só o destino; traceroute TCP hop a hop exigiria driver de captura de pacotes.
- O som do alerta toca no computador que roda o Pingger. A notificação aparece na janela aberta.
- O MOS usa o modelo E simplificado (ITU-T G.107).
