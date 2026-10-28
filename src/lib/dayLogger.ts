import {
  type AIFoodLookupResult,
  callGeminiJson,
  loadGeminiKey,
  lookupFoodWithGemini,
} from './geminiAi.ts'

// ============================================================================
// Types & Interfaces
// ============================================================================

export type Slot =
  | 'Café / Merenda'
  | 'Almoço'
  | 'Pré-Treino'
  | 'Jantar'
  | 'Refeição Livre / Lanche'
  | 'Merenda da Escola'
  | 'Jantar Único'

export interface DayLogMealItem {
  name: string
  grams: number
  kcal: number
  protein: number
  carbs: number
  fat: number
  slot: Slot
  foodId?: number
  isCustomFood?: boolean
}

export interface DayLogDraft {
  id?: string
  idempotencyToken?: string
  meals: DayLogMealItem[]
  waterMl?: number
  creatine?: boolean
  bikeActivity?: { km: number; minutes?: number; label?: string }
  gymWorkout?: { group: 'A' | 'B' | 'C'; label?: string }
  walkingActivity?: { km?: number; steps?: number; minutes?: number }
}

export interface DayLoggerTurnResult {
  status: 'needs_clarification' | 'ready_to_confirm' | 'error'
  replyMessage: string
  clarifyingQuestions?: string[]
  draft?: DayLogDraft | null
  errorMessage?: string
}

export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

export type Food = {
  id: number
  description: string
  category: string
  energy_kcal?: number | string
  protein_g?: number | string
  carbohydrate_g?: number | string
  lipid_g?: number | string
  source?: 'TACO' | 'Estimativa' | 'Mercado Online' | 'IA Gemini'
  unitKcal?: number
}

export type Item = {
  id: string
  foodId: number
  name: string
  grams: number
  kcal?: number
  protein?: number
  carbs?: number
  fat?: number
  source?: 'TACO' | 'Estimativa' | 'Mercado Online' | 'IA Gemini'
}

export type Meal = {
  id: string
  slot: Slot
  time: string
  date: string
  items: Item[]
}

export type Activity = {
  id: string
  kind: string
  date: string
  done: boolean
  km?: number
  minutes?: number
  label?: string
}

export type Measure = {
  id: string
  date: string
  weight?: number
  bodyFat?: number
  muscle?: number
  hydration?: number
  waist?: number
  chest?: number
  arm?: number
}

export type Exercise = {
  id: string
  name: string
  sets: Array<{ reps: number; weight: number | null }>
}

export type Training = {
  id: string
  date: string
  group: 'A' | 'B' | 'C'
  exercises: Array<{
    exerciseId: string
    name: string
    sets: Array<{ reps: number; weight: number | null }>
  }>
}

export type Store = {
  updatedAt?: number
  meals: Meal[]
  water: Record<string, number>
  activities: Activity[]
  comparison: number | null
  comparisonConfirmed: boolean
  waterReference: number
  bottleMl: number
  servings: Record<string, number>
  creatine: Record<string, boolean>
  measures: Measure[]
  combos: Array<{ id: string; name: string; items: Array<{ foodId: number; grams: number }> }>
  customFoods: Food[]
  exercises: Record<'A' | 'B' | 'C', Exercise[]>
  trainings: Training[]
}

// In-memory token set for rapid double-click guard
const appliedDraftTokens = new Set<string>()

// ============================================================================
// Helpers: Normalization, Sanitization & Math
// ============================================================================

export function norm(value: string | unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[,;._-]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function sanitizeText(str: string | unknown): string {
  return String(str ?? '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .trim()
}

export function sanitizeTextInput(text: string | unknown): string {
  return sanitizeText(text)
}

export function clampNumber(val: number, min: number, max: number): number {
  if (isNaN(val) || !Number.isFinite(val)) return min
  return Math.min(max, Math.max(min, val))
}

export function sanitizeNumber(
  val: string | number | null | undefined,
  min = 0,
  max = 99999
): number {
  if (val === '' || val === null || val === undefined) return min
  const str = String(val).replace(',', '.')
  const parsed = parseFloat(str)
  if (isNaN(parsed) || !Number.isFinite(parsed)) return min
  return Math.min(max, Math.max(min, parsed))
}

export function slotMatches(meal: Meal, target: Slot): boolean {
  return (
    meal.slot === target ||
    (target === 'Merenda da Escola' && meal.slot === 'Café / Merenda') ||
    (target === 'Jantar Único' && meal.slot === 'Jantar')
  )
}

export const SLOTS_DEFAULT_TIME: Record<Slot, string> = {
  'Merenda da Escola': '10:00',
  'Almoço': '12:00',
  'Pré-Treino': '16:00',
  'Jantar Único': '21:00',
  'Refeição Livre / Lanche': '12:00',
  'Café / Merenda': '10:00',
  'Jantar': '21:00',
}

function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `id-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

// ============================================================================
// Portion Macros & Unlisted Food Auto-Resolution
// ============================================================================

export function calculatePortionMacros(
  food: {
    energy_kcal?: number | string
    protein_g?: number | string
    carbohydrate_g?: number | string
    lipid_g?: number | string
    unitKcal?: number
  } | null | undefined,
  grams: number
): { kcal: number; protein: number; carbs: number; fat: number } {
  const safeFood = food || {}
  const cleanGrams = Number.isFinite(grams) ? Math.max(0, grams) : 0
  const unitKcal =
    typeof safeFood.unitKcal === 'number' && Number.isFinite(safeFood.unitKcal)
      ? safeFood.unitKcal
      : undefined
  const energy = Number(safeFood.energy_kcal) || 0
  const prot = Number(safeFood.protein_g) || 0
  const carbs = Number(safeFood.carbohydrate_g) || 0
  const fat = Number(safeFood.lipid_g) || 0

  const kcal =
    unitKcal !== undefined
      ? Math.round(unitKcal * cleanGrams)
      : Math.round((energy * cleanGrams) / 100)

  const protein = Number(((prot * cleanGrams) / 100).toFixed(1)) || 0
  const carbsTotal = Number(((carbs * cleanGrams) / 100).toFixed(1)) || 0
  const fatTotal = Number(((fat * cleanGrams) / 100).toFixed(1)) || 0

  return {
    kcal: isNaN(kcal) ? 0 : kcal,
    protein: isNaN(protein) ? 0 : protein,
    carbs: isNaN(carbsTotal) ? 0 : carbsTotal,
    fat: isNaN(fatTotal) ? 0 : fatTotal,
  }
}

export async function autoResolveUnlistedFood(
  geminiKey: string,
  foodName: string,
  userGrams = 100,
  slot: Slot = 'Almoço',
  existingCustomFoods: Food[] = []
): Promise<{ food: Food; mealItem: DayLogMealItem }> {
  const cleanName = sanitizeText(foodName)
  const existing = existingCustomFoods.find(
    (f) => norm(f.description) === norm(cleanName)
  )

  if (existing) {
    const macros = calculatePortionMacros(existing, userGrams)
    return {
      food: existing,
      mealItem: {
        name: existing.description,
        grams: userGrams,
        kcal: macros.kcal,
        protein: macros.protein,
        carbs: macros.carbs,
        fat: macros.fat,
        slot,
        foodId: existing.id,
        isCustomFood: true,
      },
    }
  }

  const lookupResult: AIFoodLookupResult = await lookupFoodWithGemini(
    geminiKey,
    cleanName
  )

  const foodId = -Date.now() - Math.floor(Math.random() * 1000)
  const newFood: Food = {
    id: foodId,
    description: lookupResult.description || cleanName,
    category: lookupResult.category || 'IA Gemini · Rótulo Oficial',
    energy_kcal: lookupResult.energy_kcal_100g,
    protein_g: lookupResult.protein_g_100g,
    carbohydrate_g: lookupResult.carbohydrate_g_100g,
    lipid_g: lookupResult.lipid_g_100g,
    source: 'IA Gemini',
  }

  const effectiveGrams = userGrams > 0 ? userGrams : lookupResult.suggested_grams || 100
  const macros = calculatePortionMacros(newFood, effectiveGrams)

  const mealItem: DayLogMealItem = {
    name: newFood.description,
    grams: effectiveGrams,
    kcal: macros.kcal,
    protein: macros.protein,
    carbs: macros.carbs,
    fat: macros.fat,
    slot,
    foodId: newFood.id,
    isCustomFood: true,
  }

  return { food: newFood, mealItem }
}

// ============================================================================
// Draft Validation & Sanitization
// ============================================================================

export function validateAndSanitizeDraft(draft?: DayLogDraft | null): DayLogDraft {
  if (!draft || typeof draft !== 'object') {
    return {
      id: generateUuid(),
      meals: [],
    }
  }

  const sanitizedMeals: DayLogMealItem[] = (draft.meals || []).map((m) => {
    const rawGrams = m.grams as unknown
    const parsedGrams =
      rawGrams !== undefined && rawGrams !== null && rawGrams !== ''
        ? typeof rawGrams === 'number'
          ? rawGrams
          : parseFloat(String(rawGrams).replace(',', '.'))
        : NaN
    const cleanGrams =
      isNaN(parsedGrams) || !Number.isFinite(parsedGrams)
        ? 100
        : Math.max(1, Math.min(10000, parsedGrams))

    return {
      name: sanitizeText(m.name || 'Alimento'),
      grams: cleanGrams,
      kcal: Math.max(0, Math.min(10000, sanitizeNumber(m.kcal, 0))),
      protein: Math.max(0, Math.min(1000, sanitizeNumber(m.protein, 0))),
      carbs: Math.max(0, Math.min(1000, sanitizeNumber(m.carbs, 0))),
      fat: Math.max(0, Math.min(1000, sanitizeNumber(m.fat, 0))),
      slot: m.slot || 'Almoço',
      foodId: typeof m.foodId === 'number' ? m.foodId : undefined,
      isCustomFood: Boolean(m.isCustomFood || (typeof m.foodId === 'number' && m.foodId < 0)),
    }
  })

  let waterMl = draft.waterMl
  if (waterMl !== undefined && waterMl !== null) {
    waterMl = Math.max(0, Math.min(20000, sanitizeNumber(waterMl, 0)))
  }

  let bikeActivity = draft.bikeActivity
  if (bikeActivity) {
    bikeActivity = {
      km: Math.max(0, Math.min(500, sanitizeNumber(bikeActivity.km, 0))),
      minutes:
        bikeActivity.minutes !== undefined
          ? Math.max(0, Math.min(1440, sanitizeNumber(bikeActivity.minutes, 0)))
          : undefined,
      label: bikeActivity.label ? sanitizeText(bikeActivity.label) : undefined,
    }
  }

  let gymWorkout = draft.gymWorkout
  if (gymWorkout) {
    const validGroup: 'A' | 'B' | 'C' =
      gymWorkout.group === 'B' ? 'B' : gymWorkout.group === 'C' ? 'C' : 'A'
    gymWorkout = {
      group: validGroup,
      label: gymWorkout.label ? sanitizeText(gymWorkout.label) : undefined,
    }
  }

  let walkingActivity = draft.walkingActivity
  if (walkingActivity) {
    walkingActivity = {
      km:
        walkingActivity.km !== undefined
          ? Math.max(0, Math.min(100, sanitizeNumber(walkingActivity.km, 0)))
          : undefined,
      steps:
        walkingActivity.steps !== undefined
          ? Math.max(0, Math.min(100000, sanitizeNumber(walkingActivity.steps, 0, 100000)))
          : undefined,
      minutes:
        walkingActivity.minutes !== undefined
          ? Math.max(0, Math.min(1440, sanitizeNumber(walkingActivity.minutes, 0)))
          : undefined,
    }
  }

  return {
    id: draft.id || generateUuid(),
    idempotencyToken: draft.idempotencyToken,
    meals: sanitizedMeals,
    waterMl,
    creatine: draft.creatine !== undefined ? Boolean(draft.creatine) : undefined,
    bikeActivity,
    gymWorkout,
    walkingActivity,
  }
}

// ============================================================================
// Multi-Turn Narration Processor (Prompt Engine)
// ============================================================================

export async function processUserNarration(
  text: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  currentDraft: DayLogDraft | null = null,
  geminiKey?: string
): Promise<DayLoggerTurnResult> {
  const safeText = typeof text === 'string' ? text : String(text ?? '')
  const trimmed = safeText.trim()
  if (!trimmed) {
    return {
      status: 'error',
      replyMessage: 'Por favor, digite ou dite o que você comeu ou treinou hoje.',
      errorMessage: 'Mensagem vazia.',
      draft: null,
    }
  }

  // Pre-flight check for browser offline status (safe across Node.js and SSR)
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return {
      status: 'error',
      replyMessage: 'Você está sem conexão com a internet. Verifique sua rede e tente novamente.',
      errorMessage: 'Dispositivo sem conexão com a internet (navigator.onLine === false).',
      draft: null,
    }
  }

  const apiKey = (geminiKey || '').trim() || loadGeminiKey()

  const systemPrompt = `Você é o assistente inteligente de nutrição e treino do Diário IA (Diário do Dia) do aplicativo pessoal KAKE.
Analise a narração (narration) em texto livre do diário do usuário, o histórico da conversa e o rascunho atual para extrair refeições, porções, água, creatina, pedaladas e treinos.

REGRAS:
1. Alimentos (meals): cada item deve ter:
   - "name": nome claro do alimento (ex: Arroz, Feijão, Lombo suíno, Batata frita, Ovos, Farinha de puba)
   - "grams": quantidade em gramas/ml
   - "kcal", "protein", "carbs", "fat": macronutrientes da porção
   - "slot": 'Merenda da Escola' | 'Almoço' | 'Pré-Treino' | 'Jantar Único' | 'Refeição Livre / Lanche'
   - "isCustomFood": true se for alimento regional, artesanal ou rótulo não tradicional (ex: farinha de puba, suplementos específicos).
2. Água (waterMl): total em ml consumido no dia (ex: 2000).
3. Creatina (creatine): true se confirmou que tomou, false se disse que não tomou, omitido se não mencionado.
4. Atividades físicas:
   - bikeActivity: { km: number, minutes?: number, label?: string } (se houver ida e volta, some os km totais).
   - gymWorkout: { group: 'A' | 'B' | 'C', label?: string }
   - walkingActivity: { km?: number, steps?: number, minutes?: number }
5. Ambiguidades (status: 'needs_clarification'):
   Se faltarem dados essenciais como:
   - distância de deslocamento ("fui de bike" sem km),
   - porções vagas ("uma concha", "farinha de puba sem gramas"),
   - ou se não mencionou água nem creatina no dia,
   defina status "needs_clarification", formule "clarifyingQuestions" e escreva uma "replyMessage" cordial e objetiva em português do Brasil sem emojis.
6. Pronto para confirmação (status: 'ready_to_confirm'):
   Se tudo estiver claro ou após o usuário responder às dúvidas, monte o "draft" completo, defina status "ready_to_confirm" e em "replyMessage" convide-o a conferir o resumo antes de salvar.
7. Entrada sem sentido / nonsense (status: 'error'):
   Se a entrada for aleatória ou não tiver relação com alimentação ou treinos:
   status: "error", errorMessage: "Entrada não reconhecida.", replyMessage: "Não consegui identificar refeições ou atividades físicas na mensagem. Por favor, conte o que você comeu, bebeu ou treinou hoje."

Retorne EXCLUSIVAMENTE um objeto JSON válido com este formato:
{
  "status": "needs_clarification" | "ready_to_confirm" | "error",
  "replyMessage": "mensagem amigável em pt-BR",
  "clarifyingQuestions": ["pergunta 1", "pergunta 2"],
  "draft": {
    "meals": [
      { "name": "Arroz", "grams": 100, "kcal": 128, "protein": 2.5, "carbs": 28.1, "fat": 0.2, "slot": "Almoço", "isCustomFood": false }
    ],
    "waterMl": 2000,
    "creatine": true,
    "bikeActivity": { "km": 5.0, "minutes": 25, "label": "Pedalada" },
    "gymWorkout": { "group": "A", "label": "Treino A" }
  },
  "errorMessage": null
}`

  const historyContext =
    history.length > 0
      ? `\nHISTÓRICO DA CONVERSA:\n${history
          .map((h) => `${h.role === 'user' ? 'Usuário' : 'Assistente'}: ${h.content}`)
          .join('\n')}`
      : ''

  const currentDraftContext = currentDraft
    ? `\nRASCUNHO ATUAL:\n${JSON.stringify(currentDraft, null, 2)}`
    : ''

  const safeInput = trimmed.length > 8000 ? trimmed.slice(0, 8000) : trimmed
  const fullPrompt = `${systemPrompt}\n${historyContext}\n${currentDraftContext}\n\nMENSAGEM DO USUÁRIO:\n"${safeInput}"`

  try {
    const rawRes = await callGeminiJson<DayLoggerTurnResult>(apiKey, fullPrompt)

    if (!rawRes || typeof rawRes !== 'object') {
      return {
        status: 'error',
        replyMessage: 'Não foi possível processar a mensagem. Tente novamente.',
        errorMessage: 'Resposta inválida da IA.',
        draft: null,
      }
    }

    if (rawRes.status === 'error') {
      return {
        status: 'error',
        replyMessage:
          rawRes.replyMessage ||
          'Não consegui identificar registros na sua mensagem. Por favor, conte o que você comeu, bebeu ou treinou hoje.',
        errorMessage: rawRes.errorMessage || 'Entrada não reconhecida.',
        draft: null,
      }
    }

    const draft = rawRes.draft ? validateAndSanitizeDraft(rawRes.draft) : null

    return {
      status: rawRes.status || (draft ? 'ready_to_confirm' : 'needs_clarification'),
      replyMessage: rawRes.replyMessage || '',
      clarifyingQuestions: Array.isArray(rawRes.clarifyingQuestions)
        ? rawRes.clarifyingQuestions
        : [],
      draft,
      errorMessage: rawRes.errorMessage,
    }
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err)
    const isExplicitlyOffline = typeof navigator !== 'undefined' && navigator.onLine === false
    const isInvalidKey =
      /inválida|api key|chave|permission|permissão|http 400|http 401|http 403|unauthenticated|unauthorized/i.test(
        rawMsg
      )
    const isServerError =
      /500|502|503|504|servidor|internal server error/i.test(rawMsg)
    const isOffline =
      isExplicitlyOffline ||
      (!isInvalidKey &&
        !isServerError &&
        /offline|fetch failed|failed to fetch|networkerror|network error|falha de conexão|enotfound|econnrefused/i.test(
          rawMsg
        ))

    let friendlyMsg = 'Não foi possível conectar com a IA no momento. Tente novamente em instantes.'
    if (isInvalidKey) {
      friendlyMsg =
        'Chave da API Gemini não configurada ou inválida. Por favor, verifique a chave nas Configurações do app.'
    } else if (isServerError) {
      friendlyMsg =
        'O serviço de IA do Gemini está temporariamente indisponível (HTTP 500). Por favor, tente novamente em instantes.'
    } else if (isOffline) {
      friendlyMsg = 'Você está sem conexão com a internet. Verifique sua rede e tente novamente.'
    }

    return {
      status: 'error',
      replyMessage: friendlyMsg,
      errorMessage: rawMsg,
      draft: null,
    }
  }
}

// ============================================================================
// Idempotency & Batch Store Applicator
// ============================================================================

export function createDraftIdempotencyToken(draft: DayLogDraft, dateStr: string): string {
  if (draft.idempotencyToken) return draft.idempotencyToken
  if (draft.id) return `${dateStr}_${draft.id}`
  const mealFingerprint = (draft.meals || [])
    .map((m) => `${m.name}:${m.grams}:${m.slot}`)
    .join('|')
  return `${dateStr}_${draft.waterMl || 0}_${draft.creatine || false}_${
    draft.bikeActivity?.km || 0
  }_${draft.gymWorkout?.group || ''}_${mealFingerprint}`
}

export function isDraftAlreadyApplied(
  store: Store,
  draft: DayLogDraft,
  dateStr: string
): boolean {
  if (!draft || typeof draft !== 'object') return false

  const token = draft.idempotencyToken || (draft.id ? `${dateStr}_${draft.id}` : null)
  if (token && appliedDraftTokens.has(token)) {
    return true
  }

  const hasItemsToCheck =
    (Array.isArray(draft.meals) && draft.meals.length > 0) ||
    (draft.waterMl !== undefined && draft.waterMl !== null) ||
    (draft.creatine !== undefined && draft.creatine !== null) ||
    (draft.bikeActivity && draft.bikeActivity.km > 0) ||
    (draft.gymWorkout && Boolean(draft.gymWorkout.group)) ||
    (draft.walkingActivity &&
      Boolean(draft.walkingActivity.km || draft.walkingActivity.steps || draft.walkingActivity.minutes))

  if (!hasItemsToCheck) {
    return false
  }

  // If draft has meals, check if all draft meals are already in store for dateStr matching slot and grams
  if (Array.isArray(draft.meals) && draft.meals.length > 0) {
    const dayMeals = (store.meals || []).filter((m) => m.date === dateStr)
    const matchedStoreItemIds = new Set<string>()

    const allMealsPresent = draft.meals.every((draftItem) => {
      const targetMeals = dayMeals.filter((m) => slotMatches(m, draftItem.slot))
      for (const meal of targetMeals) {
        for (const storeItem of meal.items) {
          if (!matchedStoreItemIds.has(storeItem.id)) {
            const sameName = norm(storeItem.name) === norm(draftItem.name)
            const sameGrams = Math.abs(storeItem.grams - draftItem.grams) < 0.5
            if (sameName && sameGrams) {
              matchedStoreItemIds.add(storeItem.id)
              return true
            }
          }
        }
      }
      return false
    })

    if (!allMealsPresent) {
      return false
    }
  }

  // If water is specified, check if store has it
  if (draft.waterMl !== undefined && draft.waterMl !== null) {
    if (store.water?.[dateStr] !== draft.waterMl) {
      return false
    }
  }

  // If creatine is specified, check if store has it
  if (draft.creatine !== undefined && draft.creatine !== null) {
    if (store.creatine?.[dateStr] !== Boolean(draft.creatine)) {
      return false
    }
  }

  // If bike activity is specified, check if store has it
  if (draft.bikeActivity && draft.bikeActivity.km > 0) {
    const hasBike = (store.activities || []).some(
      (a) => a.date === dateStr && a.kind === 'Bike' && a.km === draft.bikeActivity!.km
    )
    if (!hasBike) {
      return false
    }
  }

  // If walking activity is specified, check if store has it
  if (
    draft.walkingActivity &&
    (draft.walkingActivity.km || draft.walkingActivity.steps || draft.walkingActivity.minutes)
  ) {
    const hasWalk = (store.activities || []).some(
      (a) =>
        a.date === dateStr &&
        a.kind === 'Passos · registro manual' &&
        (draft.walkingActivity!.km === undefined || a.km === draft.walkingActivity!.km) &&
        (draft.walkingActivity!.steps === undefined ||
          (a.label && a.label.includes(String(draft.walkingActivity!.steps))))
    )
    if (!hasWalk) {
      return false
    }
  }

  // If gym workout is specified, check if store has it
  if (draft.gymWorkout && draft.gymWorkout.group) {
    const hasWorkout = (store.trainings || []).some(
      (t) => t.date === dateStr && t.group === draft.gymWorkout!.group
    )
    if (!hasWorkout) {
      return false
    }
  }

  // If everything in draft is already present in store, it was already applied
  return true
}

export function applyDayLogDraftToStore(
  store: Store,
  draft: DayLogDraft,
  dateStr: string
): { updatedStore: Store; customFoodsAdded: Food[] } {
  // 0. Sanitize Untrusted Draft
  const safeDraft = validateAndSanitizeDraft(draft)

  // 1. Idempotency Guard (Rapid Double Confirmation Protection)
  const token = createDraftIdempotencyToken(safeDraft, dateStr)
  if (token && appliedDraftTokens.has(token)) {
    return { updatedStore: store, customFoodsAdded: [] }
  }

  if (isDraftAlreadyApplied(store, safeDraft, dateStr)) {
    if (token) {
      appliedDraftTokens.add(token)
    }
    return { updatedStore: store, customFoodsAdded: [] }
  }

  if (token) {
    appliedDraftTokens.add(token)
  }

  const customFoodsAdded: Food[] = []
  const nextMeals: Meal[] = [...(store.meals || [])]
  const currentCustomFoods = [...(store.customFoods || [])]

  // 2. Process Meals & Custom Foods
  if (Array.isArray(safeDraft.meals) && safeDraft.meals.length > 0) {
    for (const item of safeDraft.meals) {
      let foodId = item.foodId

      // Check if food already exists in customFoods or was added in this batch
      const existingCustom = [...currentCustomFoods, ...customFoodsAdded].find(
        (f) => norm(f.description) === norm(item.name)
      )

      if (existingCustom) {
        foodId = existingCustom.id
      } else if (
        Boolean(item.isCustomFood) ||
        (typeof foodId === 'number' && foodId < 0)
      ) {
        const assignedId =
          typeof foodId === 'number' && foodId < 0
            ? foodId
            : -Date.now() - Math.floor(Math.random() * 1000) - customFoodsAdded.length - 1

        const grams = item.grams > 0 ? item.grams : 100
        const newFood: Food = {
          id: assignedId,
          description: item.name,
          category: 'IA Gemini · Diário',
          energy_kcal: Math.round((item.kcal / grams) * 100),
          protein_g: Number(((item.protein / grams) * 100).toFixed(1)),
          carbohydrate_g: Number(((item.carbs / grams) * 100).toFixed(1)),
          lipid_g: Number(((item.fat / grams) * 100).toFixed(1)),
          source: 'IA Gemini',
        }
        customFoodsAdded.push(newFood)
        foodId = assignedId
      }

      const newItem: Item = {
        id: generateUuid(),
        foodId: foodId || 0,
        name: item.name,
        grams: item.grams,
        kcal: item.kcal,
        protein: item.protein,
        carbs: item.carbs,
        fat: item.fat,
        source:
          item.isCustomFood || (typeof foodId === 'number' && foodId < 0)
            ? 'IA Gemini'
            : 'TACO',
      }

      const existingMealIndex = nextMeals.findIndex(
        (m) => m.date === dateStr && slotMatches(m, item.slot)
      )

      if (existingMealIndex >= 0) {
        const meal = nextMeals[existingMealIndex]
        nextMeals[existingMealIndex] = {
          ...meal,
          items: [...meal.items, newItem],
        }
      } else {
        const defaultTime = SLOTS_DEFAULT_TIME[item.slot] || '12:00'
        nextMeals.push({
          id: generateUuid(),
          slot: item.slot,
          time: defaultTime === 'Livre' ? '12:00' : defaultTime,
          date: dateStr,
          items: [newItem],
        })
      }
    }
  }

  // 3. Process Water (ml)
  const nextWater = { ...(store.water || {}) }
  if (safeDraft.waterMl !== undefined && safeDraft.waterMl !== null) {
    nextWater[dateStr] = Math.max(0, Math.min(20000, sanitizeNumber(safeDraft.waterMl, 0)))
  }

  // 4. Process Creatine (boolean)
  const nextCreatine = { ...(store.creatine || {}) }
  if (safeDraft.creatine !== undefined && safeDraft.creatine !== null) {
    nextCreatine[dateStr] = Boolean(safeDraft.creatine)
  }

  // 5. Process Activities (Bike & Walking)
  const nextActivities: Activity[] = [...(store.activities || [])]
  if (safeDraft.bikeActivity && safeDraft.bikeActivity.km > 0) {
    nextActivities.push({
      id: generateUuid(),
      kind: 'Bike',
      date: dateStr,
      done: true,
      km: sanitizeNumber(safeDraft.bikeActivity.km, 0, 500),
      minutes: safeDraft.bikeActivity.minutes
        ? sanitizeNumber(safeDraft.bikeActivity.minutes, 0, 1440)
        : undefined,
      label: safeDraft.bikeActivity.label || 'Pedalada registrada via Diário IA',
    })
  }

  if (
    safeDraft.walkingActivity &&
    (safeDraft.walkingActivity.km || safeDraft.walkingActivity.steps || safeDraft.walkingActivity.minutes)
  ) {
    nextActivities.push({
      id: generateUuid(),
      kind: 'Passos · registro manual',
      date: dateStr,
      done: true,
      km: safeDraft.walkingActivity.km
        ? sanitizeNumber(safeDraft.walkingActivity.km, 0, 100)
        : undefined,
      minutes: safeDraft.walkingActivity.minutes
        ? sanitizeNumber(safeDraft.walkingActivity.minutes, 0, 1440)
        : undefined,
      label: safeDraft.walkingActivity.steps
        ? `${safeDraft.walkingActivity.steps} passos`
        : 'Caminhada registrada via Diário IA',
    })
  }

  // 6. Process Gym Workout (Trainings & Academia Activity)
  const nextTrainings: Training[] = [...(store.trainings || [])]
  if (safeDraft.gymWorkout && safeDraft.gymWorkout.group) {
    const group = safeDraft.gymWorkout.group
    const configuredExercises = store.exercises?.[group] || []
    const trainingExercises =
      configuredExercises.length > 0
        ? configuredExercises.map((e) => ({
            exerciseId: e.id || generateUuid(),
            name: e.name,
            sets: e.sets && e.sets.length > 0 ? e.sets : [{ reps: 10, weight: null }],
          }))
        : [
            {
              exerciseId: generateUuid(),
              name: `Treino ${group}`,
              sets: [{ reps: 10, weight: null }],
            },
          ]

    nextTrainings.push({
      id: generateUuid(),
      date: dateStr,
      group,
      exercises: trainingExercises,
    })

    const alreadyHasGym = nextActivities.some(
      (a) => a.date === dateStr && a.kind === 'Academia' && a.done
    )
    if (!alreadyHasGym) {
      nextActivities.push({
        id: generateUuid(),
        kind: 'Academia',
        date: dateStr,
        done: true,
        label: safeDraft.gymWorkout.label || `Treino ${group}`,
      })
    }
  }

  // 7. Compose Immutable Updated Store
  const updatedStore: Store = {
    ...store,
    updatedAt: Date.now(),
    meals: nextMeals,
    water: nextWater,
    creatine: nextCreatine,
    activities: nextActivities,
    trainings: nextTrainings,
    customFoods: [...customFoodsAdded, ...(store.customFoods || [])],
  }

  return {
    updatedStore,
    customFoodsAdded,
  }
}
