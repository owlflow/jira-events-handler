// TODO: Apply Logging middleware for better logging
'use strict'
import * as request from 'request-promise'

import {
  EventPublisher,
  FlowContext,
  FlowNodeContext,
  Utils
} from '@owlflow/common'

// The event handler endpoints
exports.jiraSoftwareCloudV3Handler = async (event, context, callback) => {
  try {
    console.log(JSON.stringify(event))

    const nodeData = event.detail.nodeDetail

    if (nodeData.paused || nodeData.rootPaused) {
      throw new Error('OWLFlow root or node is inactive')
    }

    let actionsRes = {}

    await Utils.asyncForEach((nodeData.actions || []), async (action) => {
      let uri,
        issueKey
      switch (action) {
        case 'isIssueExists' || 'getIssue':
          issueKey = event.detail.flattenData[nodeData.meta[action].issueKey]
          uri = `https://${nodeData.meta.siteUrl}/rest/api/3/issue/${issueKey}`

          try {
            let data = await request({
              method: 'GET',
              uri,
              auth: {
                user: nodeData.meta.username,
                pass: nodeData.meta.password
              },
              json: true
            })

            delete data['fields']['comment']['comments']

            actionsRes['is_issue_exists'] = true
            actionsRes['issue'] = data
          } catch (e) {
            console.log(e.error)
            actionsRes['is_issue_exists'] = false
            actionsRes['is_issue_exists_errors'] = (e.error || {}).errorMessages
          }

          break

        case 'updateAssignee':
          uri = `https://${nodeData.meta.siteUrl}/rest/api/3/issue/${event.detail.flattenData[nodeData.rootId + '_issue_key']}/assignee`

          await request({
            method: 'PUT',
            uri,
            auth: {
              user: nodeData.meta.username,
              pass: nodeData.meta.password
            },
            body: nodeData.meta[action].body,
            json: true
          })
          break

        case 'updateTransitions':
          issueKey = event.detail.flattenData[nodeData.meta[action].issueKey]

          uri = `https://${nodeData.meta.siteUrl}/rest/api/3/issue/${issueKey}/transitions`
          await request({
            method: 'POST',
            uri,
            auth: {
              user: nodeData.meta.username,
              pass: nodeData.meta.password
            },
            body: nodeData.meta[action].body,
            json: true
          })
          break
      }
    })

    const flattenDataRes = {}
    Utils.flattenObject(actionsRes, flattenDataRes, nodeData.id)

    console.log(Object.assign(event.detail.flattenData, flattenDataRes))

    await Utils.asyncForEach((nodeData.childrenIds || []), async (childrenId) => {
      const childrenNode = await FlowNodeContext.byNodeId(event.detail.flowId, childrenId) // nodes[childrenId]

      console.log(childrenNode)

      console.log(await EventPublisher.execute({
        Entries: [
          {
            Detail: JSON.stringify({
              event: 'owlflow.hooks',
              eventSource: 'hooks.owlflow.io',
              eventVersion: '1.0',
              consumerAPI: childrenNode.api,
              organizationId: event.detail.organizationId,
              flowId: event.detail.flowId,
              nodeDetail: childrenNode,
              flattenData: Object.assign(event.detail.flattenData, flattenDataRes)
            }),
            DetailType: 'owlflow',
            EventBusName: process.env.OWLHUB_EVENT_BUS_NAME,
            Resources: [
              `orn:owlhub:owlflow:${event.detail.organizationId}:flows/${event.detail.flowId}`
            ],
            Source: 'owlhub.owlflow'
          }
        ]
      }))
    })
  } catch (e) {
    console.log(e)
  } finally {
    callback(null, {
      statusCode: '200',
      body: JSON.stringify(event),
      headers: {
        'Content-Type': 'application/json'
      }
    })
  }
}

// The public HTTP Api endpoints
exports.jiraWebhookHandler = async (event, context, callback) => {
  try {
    console.log(JSON.stringify(event))

    if (!['Atlassian Webhook HTTP Client'].includes(event.headers['User-Agent'])) {
      throw new Error('Invalid jira webhook user agent')
    }

    const { organizationId, webhookId } = event.pathParameters

    const flowData = await FlowContext.byWebhookId(organizationId, webhookId)

    if (flowData.paused) {
      throw new Error('OWLFlow flow is inactive')
    }

    const nodeData = await FlowNodeContext.byNodeId(flowData.id, flowData.parentNodeId) // nodes[flowData.parentNodeId]

    if (nodeData.paused || nodeData.rootPaused) {
      throw new Error('OWLFlow root or node is inactive')
    }

    /*
    if (nodeData.meta.headers['X-Hook-UUID'] !== event.headers['X-Hook-UUID']) {
      throw new Error('Invalid bitbucket webhook uuid')
    }
     */

    const postData = JSON.parse(event.body)
    console.log('postData', postData)

    if ((postData.webhookEvent ? !(nodeData.actions || []).includes(postData.webhookEvent) : false)) {
      throw new Error('Invalid jira webhook actions')
    }

    /*
    // Delete descriptions if pullrequest is approved or unapproved
    if (['pullrequest:approved', 'pullrequest:unapproved'].includes(event.headers['X-Event-Key'])) {
      delete postData.pullrequest.description
      delete postData.pullrequest.summary.raw
      delete postData.pullrequest.summary.html
      delete postData.pullrequest.rendered.description.markup
      delete postData.pullrequest.rendered.description.type
      delete postData.pullrequest.rendered.description.raw
      delete postData.pullrequest.rendered.description.html
    }
     */

    const res = {}
    Utils.flattenObject(postData, res, nodeData.id)

    res[`${nodeData.id}_jira_event`] = postData.webhookEvent || ''

    await Utils.asyncForEach(nodeData.childrenIds, async (childrenId) => {
      const childrenNode = await FlowNodeContext.byNodeId(flowData.id, childrenId) // nodes[childrenId]

      console.log(await EventPublisher.execute({
        Entries: [
          {
            Detail: JSON.stringify({
              event: 'owlflow.hooks',
              eventSource: 'hooks.owlflow.io',
              eventVersion: '1.0',
              consumerAPI: childrenNode.api,
              organizationId: flowData.organizationId,
              flowId: flowData.id,
              nodeDetail: childrenNode,
              flattenData: res
            }),
            DetailType: 'owlflow',
            EventBusName: process.env.OWLHUB_EVENT_BUS_NAME,
            Resources: [
              `orn:owlhub:owlflow:${flowData.organizationId}:flows/${flowData.id}`
            ],
            Source: 'owlhub.owlflow'
          }
        ]
      }))
    })
  } catch (e) {
    console.log(e)
  }

  callback(null, {
    statusCode: '200',
    body: JSON.stringify(event),
    headers: {
      'Content-Type': 'application/json'
    }
  })
}
