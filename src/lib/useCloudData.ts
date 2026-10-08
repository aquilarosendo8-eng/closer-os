import { useCallback, useEffect, useRef, useState } from 'react'
import type { Lead, LeadershipReview, LeadershipReviewInput, Settings, Stage } from '../types'
import type { WorkspaceAccess } from './access-types'
import { administrationService } from './access'
import { readableError, requireSupabase } from './supabase'
import { normalizeRecordingUrl, validLead, validLeadershipReview, validPipelineStages, validReviewInput, validSettings } from './validation'
import { getLeadStageType, normalizeLegacyLead } from './pipeline'

interface CloudData {
  leads: Lead[]
  settings: Settings
  owners: Record<string, string>
  members: { userId: string; displayName: string; email: string }[]
  stages: Stage[]
}
const emptySettings: Settings = { name: 'Closer', commissionRate: 10, revenueGoal: 200000 }

export function useCloudData(access: WorkspaceAccess | null) {
  const [data, setData] = useState<CloudData>({ leads: [], settings: emptySettings, owners: {}, members: [], stages: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loadedScope, setLoadedScope] = useState('')
  const scope = `${access?.workspace.id || ''}:${access?.membership.userId || ''}:${access?.membership.role || ''}`
  const currentScope = useRef(scope)
  currentScope.current = scope
  const workspaceId = access?.workspace.id
  const userId = access?.membership.userId
  const role = access?.membership.role
  const refresh = useCallback(async () => {
    if (!workspaceId || !userId) return
    const requestedScope = `${workspaceId}:${userId}:${role}`
    try {
      const client = requireSupabase()
      const [leadResult, settingsResult, members, stageResult, reviewResult] = await Promise.all([
        client.from('leads').select('id,owner_id,data,stage_id').eq('workspace_id', workspaceId).order('created_at', { ascending: false }),
        client.from('workspace_settings').select('name,commission_rate,revenue_goal').eq('workspace_id', workspaceId).single(),
        role === 'admin' || role === 'manager' ? administrationService.listMembers(workspaceId) : Promise.resolve([]),
        client.rpc('list_pipeline_stages', { p_workspace_id: workspaceId }),
        client.rpc('list_call_reviews', { p_workspace_id: workspaceId }),
      ])
      if (leadResult.error) throw leadResult.error
      if (settingsResult.error) throw settingsResult.error
      if (stageResult.error) throw stageResult.error
      if (reviewResult.error) throw reviewResult.error
      if (currentScope.current !== requestedScope) return
      const rows = leadResult.data || []
      const stages: Stage[] = (stageResult.data || []).map((row: Record<string, unknown>) => ({
        id: row.id as string, pipelineId: row.pipeline_id as string, name: row.name as string, position: row.position as number,
        color: row.color as string, type: row.type as Stage['type'], active: row.active as boolean, leadCount: Number(row.lead_count || 0),
      })).sort((a: Stage, b: Stage) => a.position - b.position)
      if (!validPipelineStages(stages)) throw new Error('A configuração do pipeline está incompleta. Contate o administrador antes de editar.')
      const stageMap = new Map(stages.map(stage => [stage.id, stage]))
      const reviews = new Map<string, LeadershipReview>()
      for (const row of (reviewResult.data || []) as Record<string, unknown>[]) {
        const review: LeadershipReview = {
          feedback: row.feedback as string, score: row.score as number, reviewedBy: row.reviewed_by === null ? '' : row.reviewed_by as string,
          reviewerName: typeof row.reviewer_name === 'string' ? row.reviewer_name : 'Liderança', reviewedAt: row.reviewed_at as string,
        }
        if (!validLeadershipReview(review)) throw new Error('Há uma revisão incompatível no banco. Contate o administrador.')
        reviews.set(String(row.lead_id), review)
      }
      const leads: Lead[] = rows.map(row => {
        const stage = stageMap.get(String(row.stage_id))
        if (!stage) throw new Error('Uma oportunidade não está vinculada ao pipeline da empresa. Contate o administrador.')
        const { leadershipReview: _untrustedReview, stageId: _untrustedId, stageType: _untrustedType, stageName: _untrustedName, ...fields } = row.data as Lead
        const lead = { ...fields, id: row.id, stageId: stage.id, stageType: stage.type, stageName: stage.name, ...(reviews.has(row.id) ? { leadershipReview: reviews.get(row.id) } : {}) }
        if (!validLead(lead)) throw new Error('Há um registro incompatível no banco. Contate o administrador antes de editar.')
        return lead
      })
      setData({
        leads, stages,
        owners: Object.fromEntries(rows.map(row => [row.id, row.owner_id])),
        settings: { name: settingsResult.data.name, commissionRate: Number(settingsResult.data.commission_rate), revenueGoal: Number(settingsResult.data.revenue_goal) },
        members: members.filter(row => row.active && row.role !== 'viewer').map(({ userId, displayName, email }) => ({ userId, displayName, email })),
      })
      setLoadedScope(requestedScope)
      setError('')
    } catch (cause) { if (currentScope.current === requestedScope) setError(readableError(cause)) }
    finally { if (currentScope.current === requestedScope) { setLoadedScope(requestedScope); setLoading(false) } }
  }, [workspaceId, userId, role])

  useEffect(() => {
    setData({ leads: [], settings: emptySettings, owners: {}, members: [], stages: [] }); setError(''); setLoading(Boolean(workspaceId))
    if (!workspaceId) return
    void refresh()
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 30000)
    return () => clearInterval(timer)
  }, [scope, refresh, workspaceId])

  const saveLead = async (lead: Lead) => {
    if (!workspaceId || !userId) throw new Error('Selecione uma empresa para continuar.')
    if (!validLead(lead)) throw new Error('Revise os dados do lead antes de salvar.')
    const client = requireSupabase()
    const existing = data.leads.find(item => item.id === lead.id)
    const explicit = lead.stageId ? data.stages.find(stage => stage.id === lead.stageId) : undefined
    if (lead.stageId && !explicit) throw new Error('Selecione uma etapa do pipeline desta empresa.')
    const stage = explicit || data.stages.find(item => item.id === normalizeLegacyLead(lead, data.stages).stageId)
      || (getLeadStageType(lead) === 'NORMAL' ? data.stages.find(item => item.active && item.type === 'NORMAL') : undefined)
    if (!stage || (!stage.active && existing?.stageId !== stage.id)) throw new Error('Selecione uma etapa ativa do pipeline desta empresa.')
    if (stage.type === 'WON' && lead.closedValue <= 0) throw new Error('Informe um valor fechado maior que zero.')
    if (stage.type === 'LOST' && (!existing || existing.stageId !== stage.id || Boolean(existing.lossReason)) && !lead.lossReason) throw new Error('Informe o motivo da perda antes de salvar.')
    // Canonical stage metadata and leadership authorship are supplied by database tables, never the form JSON.
    const { leadershipReview: _review, stageType: _type, stageName: _name, ...fields } = lead
    const payload = { ...fields, stageId: stage.id, ...(fields.recordingUrl !== undefined ? { recordingUrl: normalizeRecordingUrl(fields.recordingUrl) } : {}) }
    const query = existing
      ? client.from('leads').update({ data: payload, stage_id: stage.id }).eq('workspace_id', workspaceId).eq('id', lead.id)
      : client.from('leads').insert({ workspace_id: workspaceId, id: lead.id, owner_id: userId, data: payload, stage_id: stage.id })
    const result = await query.select('id').single()
    if (result.error) throw result.error
    if (!result.data) throw new Error('O lead não foi salvo. Seu acesso pode ter sido alterado.')
    await refresh()
  }
  const deleteLead = async (id: string) => {
    if (!workspaceId) throw new Error('Selecione uma empresa para continuar.')
    const { data: removed, error } = await requireSupabase().from('leads').delete().eq('workspace_id', workspaceId).eq('id', id).select('id')
    if (error) throw error
    if (!removed?.length) throw new Error('O lead não foi excluído. Verifique sua permissão.')
    await refresh()
  }
  const saveSettings = async (settings: Settings) => {
    if (!workspaceId || !validSettings(settings)) throw new Error('Informe metas e configurações válidas.')
    const { error } = await requireSupabase().from('workspace_settings').update({ name: settings.name.trim(), commission_rate: settings.commissionRate, revenue_goal: settings.revenueGoal }).eq('workspace_id', workspaceId).select('workspace_id').single()
    if (error) throw error
    await refresh()
  }
  const importLeads = async (leads: Lead[]) => {
    if (!workspaceId || !userId || !leads.every(validLead)) throw new Error('Use um backup válido do HIGH CLOSER.')
    let imported = 0, skipped = 0
    try {
      for (let offset = 0; offset < leads.length; offset += 1000) {
        // Reviews belong to a separate authenticated write path and are never restored through lead JSON.
        const records = leads.slice(offset, offset + 1000).map(({ leadershipReview: _review, ...lead }) => ({
          ...lead, ...(lead.recordingUrl !== undefined ? { recordingUrl: normalizeRecordingUrl(lead.recordingUrl) } : {}),
        }))
        const { data: result, error } = await requireSupabase().rpc('import_leads', { p_workspace_id: workspaceId, p_leads: records, p_owner_id: userId })
        if (error) throw error
        imported += Number(result?.imported || 0); skipped += Number(result?.skipped || 0)
      }
    } catch (cause) {
      await refresh()
      throw new Error(`${imported ? `${imported} leads foram importados antes da interrupção. Reimporte para continuar; os IDs existentes serão preservados. ` : ''}${readableError(cause)}`)
    }
    await refresh()
    return { imported, skipped }
  }
  const assignLead = async (leadId: string, ownerId: string) => {
    if (!workspaceId) throw new Error('Selecione uma empresa para continuar.')
    const { error } = await requireSupabase().from('leads').update({ owner_id: ownerId }).eq('workspace_id', workspaceId).eq('id', leadId).select('id').single()
    if (error) throw error
    await refresh()
  }
  const savePipelineStages = async (stages: Stage[]) => {
    if (!workspaceId || !['admin', 'manager'].includes(role || '')) throw new Error('Somente administradores e gestores podem configurar o pipeline.')
    if (!validPipelineStages(stages)) throw new Error('Revise as etapas e mantenha uma etapa de vitória e uma de perda ativas.')
    const payload = stages.map(stage => ({ ...(stage.id ? { id: stage.id } : {}), name: stage.name.trim(), color: stage.color, type: stage.type, active: stage.active }))
    const { error } = await requireSupabase().rpc('save_pipeline_stages', { p_workspace_id: workspaceId, p_stages: payload })
    if (error) throw error
    await refresh()
  }
  const reviewCall = async (leadId: string, review: LeadershipReviewInput) => {
    if (!workspaceId || !['admin', 'manager'].includes(role || '')) throw new Error('Somente administradores e gestores podem revisar calls.')
    if (!validReviewInput(review)) throw new Error('Escreva um feedback e informe uma nota inteira entre 0 e 10.')
    if (!data.leads.some(lead => lead.id === leadId)) throw new Error('A call não está disponível no seu acesso atual.')
    const { error } = await requireSupabase().rpc('review_call', { p_workspace_id: workspaceId, p_lead_id: leadId, p_feedback: review.feedback.trim(), p_score: review.score })
    if (error) throw error
    await refresh()
  }
  const displayed = loadedScope === scope ? data : { leads: [], settings: emptySettings, owners: {}, members: [], stages: [] }
  return { ...displayed, loading: loading || (Boolean(workspaceId) && loadedScope !== scope), error, refresh, saveLead, deleteLead, saveSettings, importLeads, assignLead, savePipelineStages, reviewCall }
}
