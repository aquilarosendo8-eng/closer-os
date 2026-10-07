import { createInvitationHandler } from './invitations.mjs'

export const config = { maxDuration: 60 }

export function createInvitationLinkHandler(options = {}) {
  return createInvitationHandler({ ...options, manualLink: true })
}

export default createInvitationLinkHandler()
