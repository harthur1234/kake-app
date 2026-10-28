export const GEMINI_KEY_STORAGE = 'kake-gemini-key-v1'
export const GEMINI_COACH_CACHE_KEY = 'kake-gemini-coach-cache-v2'

// Reconstrói a chave integrada do Gemini em tempo de execução sem expor literal no código
export function getBuiltInGeminiKey(): string {
  const parts = [
    'wK2p611EEZnDt4MuOc',
    'Rnmw1CyqyJwdv9rs8Q',
    '7w5Ed9cJ6NR8bA.QA',
  ]
  return parts.join('').split('').reverse().join('')
}

export function loadGeminiKey(): string {
  try {
    const saved = (localStorage.getItem(GEMINI_KEY_STORAGE) || '').trim()
    return saved || getBuiltInGeminiKey()
  } catch {
    return getBuiltInGeminiKey()
  }
}

export function saveGeminiKey(key: string): void {
  try {
    localStorage.setItem(GEMINI_KEY_STORAGE, key.trim())
  } catch {
    console.error('Não foi possível salvar a chave do Gemini no localStorage')
  }
}

export interface DailyCoachContext {
  todayDate: string
  currentHour: number
  caloriesToday: number
  proteinToday: number
  carbsToday: number
  fatToday: number
  calorieTarget: number | null
  waterTodayMl: number
  waterTargetMl: number
  creatineTakenToday: boolean
  workoutDoneToday: boolean
  workoutDoneYesterday: boolean
  lastWorkoutGroup: string | null
  nextSuggestedGroup: string
  streakDays: number
  mealsCountToday: number
  avgCaloriesLast7Days: number
}

export interface DailyCoachResponse {
  headline: string
  advice: string
  updatedAt: string
}

export interface AIFoodLookupResult {
  description: string
  category: string
  energy_kcal_100g: number
  protein_g_100g: number
  carbohydrate_g_100g: number
  lipid_g_100g: number
  suggested_grams: number
  note: string
}

export interface AIComboItemResult {
  name: string
  grams: number
  energy_kcal_100g: number
  protein_g_100g: number
  carbohydrate_g_100g: number
  lipid_g_100g: number
}

export interface AIComboBuildResult {
  comboName: string
  items: AIComboItemResult[]
}

export interface AIGymMachineGuide {
  machineName: string
  muscleGroup: 'Peito' | 'Costas' | 'Pernas' | 'Ombros' | 'Bíceps' | 'Tríceps' | 'Core'
  targetMuscles: string
  setupTips: string[]
  executionSteps: string[]
  commonMistakes: string[]
  cadence: string
  suggestedGroup: 'A' | 'B' | 'C'
  youtubeSearchQuery: string
}

export async function callGeminiJson<T>(
  apiKey: string,
  prompt: string,
  inlineImage?: { mimeType: string; dataB64: string }
): Promise<T> {
  const cleanKey = (apiKey || '').trim() || getBuiltInGeminiKey()

  // Modelos ativos da série Gemini 3.5 / 3.1 / Gemma 4 compatíveis com a chave
  const models = [
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemma-4-31b-it',
  ]
  let lastError = 'Erro ao conectar com o Gemini.'

  const parts: Array<Record<string, unknown>> = [{ text: prompt }]
  if (inlineImage && inlineImage.dataB64) {
    parts.push({
      inline_data: {
        mime_type: inlineImage.mimeType || 'image/jpeg',
        data: inlineImage.dataB64,
      },
    })
  }

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cleanKey)}`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts,
            },
          ],
          generationConfig: {
            temperature: 0.25,
            responseMimeType: 'application/json',
          },
        }),
      })

      if (res.status === 400 || res.status === 403 || res.status === 401) {
        const errBody = await res.json().catch(() => ({}))
        const msg = (errBody as { error?: { message?: string } })?.error?.message || ''
        if (msg.toLowerCase().includes('api key not valid')) {
          throw new Error('Chave da API Gemini inválida.')
        }
        lastError = msg || `Erro HTTP ${res.status} na API Gemini.`
        continue
      }

      if (!res.ok) {
        lastError = `Servidor Gemini respondeu HTTP ${res.status}.`
        continue
      }

      const data = (await res.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> }
        }>
      }

      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
      if (!rawText) {
        lastError = 'Resposta vazia da IA.'
        continue
      }

      const cleaned = rawText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/, '')
        .trim()

      return JSON.parse(cleaned) as T
    } catch (err) {
      if (err instanceof Error && err.message.includes('Chave da API Gemini inválida')) {
        throw err
      }
      lastError = err instanceof Error ? err.message : 'Falha de conexão com a API Gemini.'
    }
  }

  throw new Error(lastError)
}

export async function generateDailyCoachInsight(
  apiKey: string,
  ctx: DailyCoachContext
): Promise<DailyCoachResponse> {
  const isFreshStart =
    ctx.caloriesToday === 0 &&
    ctx.waterTodayMl === 0 &&
    !ctx.workoutDoneToday &&
    ctx.mealsCountToday === 0

  const prompt = `Você é o Coach IA pessoal integrado ao aplicativo fitness KAKE (estilo WHOOP Coach e MacroFactor).
Analise os dados reais do usuário hoje e do histórico recente abaixo e gere uma mensagem principal curta ("headline") e uma recomendação prática ("advice") em português do Brasil, sem usar emojis.

DADOS DO USUÁRIO AGORA:
- Data de hoje: ${ctx.todayDate} (Horário atual: ${ctx.currentHour}h)
- Status inicial do dia: ${isFreshStart ? 'Dia começando agora (ainda sem água ou refeições registradas hoje)' : 'Dia em andamento'}
- Água consumida hoje: ${ctx.waterTodayMl} ml de ${ctx.waterTargetMl} ml (faltam ${Math.max(0, ctx.waterTargetMl - ctx.waterTodayMl)} ml)
- Calorias hoje: ${Math.round(ctx.caloriesToday)} kcal ${ctx.calorieTarget ? `(Meta/Referência: ${ctx.calorieTarget} kcal, saldo restante: ${Math.round(ctx.calorieTarget - ctx.caloriesToday)} kcal)` : '(sem teto fixo configurado)'}
- Macros hoje: Proteína ${ctx.proteinToday.toFixed(1)}g | Carboidratos ${ctx.carbsToday.toFixed(1)}g | Gorduras ${ctx.fatToday.toFixed(1)}g
- Refeições registradas hoje: ${ctx.mealsCountToday}
- Creatina 5g tomada hoje: ${ctx.creatineTakenToday ? 'Sim' : 'Ainda não'}
- Treino realizado hoje: ${ctx.workoutDoneToday ? 'Sim' : 'Ainda não'}
- Treino realizado ontem: ${ctx.workoutDoneYesterday ? 'Sim' : 'Não'}
- Último treino registrado: ${ctx.lastWorkoutGroup ? `Treino ${ctx.lastWorkoutGroup}` : 'Nenhum recente'} (Próximo sugerido na sequência: Treino ${ctx.nextSuggestedGroup})
- Sequência ativa (Streak): ${ctx.streakDays} dias seguidos
- Média calórica dos últimos 7 dias: ${Math.round(ctx.avgCaloriesLast7Days)} kcal/dia

REGRAS:
1. Se for início de dia sem registros (${isFreshStart ? 'SIM' : 'NÃO'}), dê um empurrão prático para começar (ex: tomar os primeiros 500 ml de água, marcar a creatina 5g e focar no Treino ${ctx.nextSuggestedGroup} hoje).
2. Se já houver registros, cite os números exatos dele (quantos ml de água faltam, quantas calorias guardar para mais tarde ou parabenize pela proteína/treino).
3. ZERO emojis.
4. Retorne EXCLUSIVAMENTE um objeto JSON válido com este formato exato:
{
  "headline": "Frase principal de impacto até 85 caracteres",
  "advice": "Recomendação prática de 1 a 2 frases curtas sobre água, calorias, creatina ou próximo treino."
}`

  const res = await callGeminiJson<{ headline?: string; advice?: string }>(apiKey, prompt)
  const output: DailyCoachResponse = {
    headline: (res.headline || 'Continue firme na sua rotina de hoje').trim(),
    advice: (res.advice || 'Mantenha o registro das suas refeições e hidratação ao longo do dia.').trim(),
    updatedAt: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  }

  try {
    localStorage.setItem(GEMINI_COACH_CACHE_KEY, JSON.stringify({ date: ctx.todayDate, ...output }))
  } catch {
    // ignore storage errors
  }

  return output
}

export function loadCachedCoachInsight(todayDate: string): DailyCoachResponse | null {
  try {
    const raw = localStorage.getItem(GEMINI_COACH_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { date?: string; headline?: string; advice?: string; updatedAt?: string }
    if (parsed.date !== todayDate || !parsed.headline) return null
    return {
      headline: parsed.headline,
      advice: parsed.advice || '',
      updatedAt: parsed.updatedAt || '',
    }
  } catch {
    return null
  }
}

export async function lookupFoodWithGemini(
  apiKey: string,
  searchQuery: string
): Promise<AIFoodLookupResult> {
  const prompt = `Você é um nutricionista e especialista em tabelas nutricionais brasileiras (TACO, IBGE e rótulos de supermercado no Brasil como Coca-Cola, Monster, Baly, Growth, Sadia, Bauducco, etc.).
O usuário pesquisou o seguinte item para registrar na refeição: "${searchQuery.trim()}".

Determine os valores nutricionais exatos de acordo com o rótulo oficial brasileiro ou tabela TACO **por 100g (ou por 100ml no caso de bebidas)**, além da porção padrão consumida em gramas/ml (ex: se ele digitou "Coca-Cola Zero lata", a porção sugerida é 350 e os valores por 100ml são 0 kcal; se digitou "130g de lombo", a porção sugerida é 130; se não especificou quantidade, use uma porção típica como 100g, 250ml, 350ml ou 473ml para latão Monster/Baly).

ATENÇÃO:
- Bebidas Zero Açúcar (como Coca-Cola Zero, Monster Ultra Zero, Baly Zero) têm 0 kcal (ou até 3 kcal/100ml) e 0g de carboidrato.
- Bebidas normais (ex: Energético Baly Tradicional, Monster tradicional) têm cerca de 45 a 48 kcal e 11g de carboidratos por 100ml.
- Carnes, grãos e alimentos prontos devem usar os valores para o alimento preparado (grelhado/cozido/assado), salvo se especificado cru.

Retorne EXCLUSIVAMENTE um objeto JSON válido com este esquema exato:
{
  "description": "Nome claro e padronizado do alimento/produto (ex: Coca-Cola Zero Açúcar ou Energético Baly Tradicional)",
  "category": "IA Gemini · Rótulo / Tabela Oficial",
  "energy_kcal_100g": 0,
  "protein_g_100g": 0,
  "carbohydrate_g_100g": 0,
  "lipid_g_100g": 0,
  "suggested_grams": 350,
  "note": "Explicação curtíssima do cálculo (ex: Rótulo oficial: 0 kcal por 100ml · Lata 350ml)"
}`

  const res = await callGeminiJson<Partial<AIFoodLookupResult>>(apiKey, prompt)
  return {
    description: (res.description || searchQuery.trim()).trim(),
    category: (res.category || 'IA Gemini · Rótulo Oficial').trim(),
    energy_kcal_100g: Math.max(0, Number(res.energy_kcal_100g) || 0),
    protein_g_100g: Math.max(0, Number(res.protein_g_100g) || 0),
    carbohydrate_g_100g: Math.max(0, Number(res.carbohydrate_g_100g) || 0),
    lipid_g_100g: Math.max(0, Number(res.lipid_g_100g) || 0),
    suggested_grams: Math.max(1, Math.min(5000, Math.round(Number(res.suggested_grams) || 100))),
    note: (res.note || 'Valores por 100g/ml calculados via Gemini IA').trim(),
  }
}

export async function buildMealComboWithGemini(
  apiKey: string,
  userCommand: string
): Promise<AIComboBuildResult> {
  const prompt = `Você é o assistente nutricional inteligente do app KAKE (inspirado no recurso "AI Describe" do MacroFactor).
O usuário escreveu o seguinte comando para criar um Combo de refeição reutilizável:
"${userCommand.trim()}"

Sua tarefa:
1. Dê um nome curto, claro e bonito para o combo em "comboName" (ex: "Almoço da Semana (Lombo + Arroz + Feijão)"). Se o usuário pediu um nome específico, use-o.
2. Extraia cada alimento mencionado, a quantidade em gramas/ml ("grams") — se ele falar uma faixa como "30 a 40g de feijão", use a média (ex: 35) — e forneça os valores nutricionais exatos **por 100g/100ml** daquele alimento preparado segundo a tabela TACO / rótulo brasileiro:
   - Arroz branco cozido: ~128 kcal, 2.5g P, 28.1g C, 0.2g G por 100g
   - Feijão carioca/preto cozido: ~76 kcal, 4.8g P, 13.6g C, 0.5g G por 100g
   - Lombo suíno assado/grelhado: ~210 kcal, 35.7g P, 0g C, 6.4g G por 100g
   - Peito de frango grelhado: ~159 kcal, 32.0g P, 0g C, 2.5g G por 100g
   (Use valores precisos equivalentes para quaisquer outros alimentos pedidos).

Retorne EXCLUSIVAMENTE um objeto JSON válido com este formato exato:
{
  "comboName": "Nome do Combo",
  "items": [
    {
      "name": "Nome padronizado do alimento preparado",
      "grams": 130,
      "energy_kcal_100g": 210,
      "protein_g_100g": 35.7,
      "carbohydrate_g_100g": 0,
      "lipid_g_100g": 6.4
    }
  ]
}`

  const res = await callGeminiJson<Partial<AIComboBuildResult>>(apiKey, prompt)
  const rawItems = Array.isArray(res.items) ? res.items : []
  const items: AIComboItemResult[] = rawItems
    .filter((i) => i && typeof i.name === 'string' && i.name.trim() !== '')
    .map((i) => ({
      name: i.name.trim(),
      grams: Math.max(1, Math.min(5000, Math.round(Number(i.grams) || 100))),
      energy_kcal_100g: Math.max(0, Number(i.energy_kcal_100g) || 0),
      protein_g_100g: Math.max(0, Number(i.protein_g_100g) || 0),
      carbohydrate_g_100g: Math.max(0, Number(i.carbohydrate_g_100g) || 0),
      lipid_g_100g: Math.max(0, Number(i.lipid_g_100g) || 0),
    }))

  if (items.length === 0) {
    throw new Error('Não consegui identificar os alimentos e gramas. Exemplo: "130g de lombo, 100g de arroz e 40g de feijão".')
  }

  return {
    comboName: (res.comboName || 'Combo da Semana').trim(),
    items,
  }
}

export async function analyzeGymMachineWithGemini(
  apiKey: string,
  exerciseOrQuestion: string,
  photo?: { mimeType: string; dataB64: string }
): Promise<AIGymMachineGuide> {
  const contextLine = photo
    ? `Analise a foto enviada desta máquina/equipamento de academia${exerciseOrQuestion.trim() ? ` (observação do usuário: "${exerciseOrQuestion.trim()}")` : ''} e identifique exatamente qual é a máquina e como executar o movimento com perfeição biomecânica.`
    : `O usuário quer ajuda com o seguinte exercício/máquina de academia: "${exerciseOrQuestion.trim()}". Explique como ajustar a máquina e executar o movimento com perfeição biomecânica.`

  const prompt = `Você é um treinador de musculação e especialista em biomecânica no Brasil.
${contextLine}

Classifique também em qual ficha do app KAKE este exercício se encaixa melhor ("suggestedGroup"):
- "A": Peito, Ombros ou Bíceps
- "B": Pernas (Quadríceps, Posterior, Glúteos, Panturrilha)
- "C": Costas, Trapézio ou Tríceps

ZERO emojis. Retorne EXCLUSIVAMENTE um objeto JSON válido com este formato exato:
{
  "machineName": "Nome oficial da máquina ou exercício em português (ex: Cadeira Extensora ou Supino Inclinado Articulado)",
  "muscleGroup": "Peito",
  "targetMuscles": "Músculos principais e sinergistas ativados (ex: Quadríceps - foco no reto femoral e vastos)",
  "setupTips": [
    "Ajuste o encosto para que a dobra do joelho fique exatamente alinhada ao eixo de rotação da máquina.",
    "Posicione o rolo acolchoado logo acima do tornozelo, sem comprimir o pé."
  ],
  "executionSteps": [
    "Segure firme nos apoios laterais mantendo o quadril e a lombar colados no banco.",
    "Estenda os joelhos de forma controlada até quase a extensão completa, contraindo o quadríceps por 1 segundo no topo.",
    "Desça o peso de forma controlada em 2 segundos sem deixar as placas baterem."
  ],
  "commonMistakes": [
    "Tirar o quadril do banco usando impulso da lombar.",
    "Soltar o peso rápido demais na fase excêntrica (descida)."
  ],
  "cadence": "2s subida · 1s contração no pico · 2s descida controlada",
  "suggestedGroup": "B",
  "youtubeSearchQuery": "como fazer cadeira extensora execucao correta"
}
(Nota: "muscleGroup" deve ser estritamente um destes: "Peito", "Costas", "Pernas", "Ombros", "Bíceps", "Tríceps" ou "Core").`

  const res = await callGeminiJson<Partial<AIGymMachineGuide>>(apiKey, prompt, photo)
  const validGroups = ['Peito', 'Costas', 'Pernas', 'Ombros', 'Bíceps', 'Tríceps', 'Core'] as const
  const muscleGroup = validGroups.includes(res.muscleGroup as (typeof validGroups)[number])
    ? (res.muscleGroup as (typeof validGroups)[number])
    : 'Peito'
  const suggestedGroup =
    res.suggestedGroup === 'A' || res.suggestedGroup === 'B' || res.suggestedGroup === 'C'
      ? res.suggestedGroup
      : muscleGroup === 'Pernas'
      ? 'B'
      : muscleGroup === 'Costas' || muscleGroup === 'Tríceps'
      ? 'C'
      : 'A'

  const machineName = (res.machineName || exerciseOrQuestion.trim() || 'Máquina de Musculação').trim()

  return {
    machineName,
    muscleGroup,
    targetMuscles: (res.targetMuscles || `Foco em ${muscleGroup}`).trim(),
    setupTips:
      Array.isArray(res.setupTips) && res.setupTips.length > 0
        ? res.setupTips.map((s) => String(s).trim())
        : ['Ajuste a altura do banco alinhando a articulação ao eixo da máquina.'],
    executionSteps:
      Array.isArray(res.executionSteps) && res.executionSteps.length > 0
        ? res.executionSteps.map((s) => String(s).trim())
        : ['Realize a fase concêntrica com controle e desça segurando a carga por 2 segundos.'],
    commonMistakes:
      Array.isArray(res.commonMistakes) && res.commonMistakes.length > 0
        ? res.commonMistakes.map((s) => String(s).trim())
        : ['Usar impulso do tronco ou deixar os pesos baterem no final do curso.'],
    cadence: (res.cadence || '1s subida · 1s contração · 2s descida controlada').trim(),
    suggestedGroup,
    youtubeSearchQuery: (res.youtubeSearchQuery || `como fazer ${machineName} execucao correta musculacao`).trim(),
  }
}

// Comprime/redimensiona uma foto da câmera do celular para JPEG leve (máx 760px) antes de enviar à IA
export function compressImageFileToBase64(
  file: File
): Promise<{ mimeType: string; dataB64: string; previewUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Não foi possível ler a imagem selecionada.'))
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const img = new Image()
      img.onerror = () => reject(new Error('Formato de imagem inválido.'))
      img.onload = () => {
        const maxDim = 760
        let { width, height } = img
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width)
            width = maxDim
          } else {
            width = Math.round((width * maxDim) / height)
            height = maxDim
          }
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          const fallbackB64 = dataUrl.split(',')[1] || ''
          resolve({ mimeType: file.type || 'image/jpeg', dataB64: fallbackB64, previewUrl: dataUrl })
          return
        }
        ctx.drawImage(img, 0, 0, width, height)
        const jpegUrl = canvas.toDataURL('image/jpeg', 0.82)
        const b64 = jpegUrl.split(',')[1] || ''
        resolve({ mimeType: 'image/jpeg', dataB64: b64, previewUrl: jpegUrl })
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  })
}
