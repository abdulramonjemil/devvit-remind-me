import { Devvit } from "@devvit/public-api"
import * as chrono from "chrono-node"

const APP_NAME = "RemindMe"
const REMINDER_JOB_NAME = "reminder"

type ReminderJobData = {
  userId: string
  postId: string
  initTimestamp: number
}

Devvit.configure({
  redditAPI: true,
  redis: true
})

Devvit.addSchedulerJob<ReminderJobData>({
  name: REMINDER_JOB_NAME,
  onRun: async (event, context) => {
    const { userId, postId, initTimestamp } = event.data

    const user = await context.reddit.getUserById(userId)
    const post = await context.reddit.getPostById(postId)
    if (!user || !post) return

    const message = `Hey! You asked me to remind you about [${post.title}](${post.permalink}). You set this reminder on ${new Date(initTimestamp).toUTCString()}!`

    await context.reddit.sendPrivateMessage({
      to: user.username,
      subject: `Reminder for '${post.title}' - ${APP_NAME}`,
      text: message
    })
  }
})

type RemindMeFormData = {
  reminderTimestamp: number
}

/**
 * This serves as a simple means to keep data between the multiple forms that
 * make up the app as multistep forms cannot share data if not triggered via an
 * interactive post, at least at the time of writing this.
 *
 * So, we instead store the data in redis and delete it after it is fetched. We
 * also set an expiry time so it doesn't stay in redis forever.
 */
class RemindMeFormDataFlow {
  // STEP 1
  static async setDataAfterTimeInput(
    context: Devvit.Context,
    data: RemindMeFormData
  ): Promise<void> {
    const { userId, postId } = context
    if (!userId || !postId) return
    const key = `${userId}::${postId}`

    await context.redis.hSet(key, {
      reminderTimestamp: String(data.reminderTimestamp)
    } satisfies Record<keyof RemindMeFormData, string>)
    await context.redis.expire(key, 1 * 60 * 60) // Expire after one hour
  }

  // STEP 2
  static async retrieveDataAfterTimeConfirmation(
    context: Devvit.Context
  ): Promise<RemindMeFormData | null> {
    const { userId, postId } = context
    if (!userId || !postId) return null
    const key = `${userId}::${postId}`

    const [reminderTimestamp] = await context.redis.hMGet(key, [
      "reminderTimestamp"
    ] satisfies (keyof RemindMeFormData)[])
    await context.redis.del(key)

    if (!reminderTimestamp) return null
    return { reminderTimestamp: Number(reminderTimestamp) }
  }
}

const timeConfirmationForm = Devvit.createForm(
  (data) => {
    const d = data as RemindMeFormData
    return {
      title: "Is this correct?",
      description: `I will remind you at ${new Date(d.reminderTimestamp).toUTCString()}`,
      fields: [],
      acceptLabel: "Confirm",
      cancelLabel: "Cancel"
    }
  },
  async (_, context) => {
    const { userId, postId } = context
    if (!postId) return // App should only be triggered from a post
    if (!userId) {
      context.ui.showToast("I can only remind you if you're logged in")
      return
    }

    const data =
      await RemindMeFormDataFlow.retrieveDataAfterTimeConfirmation(context)

    if (!data) {
      context.ui.showToast("An error occured while setting the reminder")
      return
    }

    const reminderDate = new Date(data.reminderTimestamp)
    const nowDate = new Date()
    if (reminderDate <= nowDate) {
      context.ui.showToast("I can't remind you in the past!")
      return
    }

    context.scheduler.runJob<ReminderJobData>({
      name: REMINDER_JOB_NAME,
      runAt: reminderDate,
      data: {
        userId,
        postId,
        initTimestamp: nowDate.getTime()
      }
    })

    context.ui.showToast(
      `Gotcha! I'll send you a message about this post at ${reminderDate.toUTCString()}!`
    )
  }
)

const timeInputForm = Devvit.createForm(
  {
    fields: [
      {
        name: "time",
        label: "When?",
        placeholder: "e.g. In one hour, 2 days from now",
        type: "string",
        required: true
      }
    ],
    title: "Remind me",
    acceptLabel: "Schedule",
    cancelLabel: "Cancel"
  },
  async (event, context) => {
    const timeString = event.values["time"]
    const parsedDate = chrono.parseDate(timeString)
    if (!parsedDate) {
      context.ui.showToast("I couldn't quite get that!")
      return
    }

    const data: RemindMeFormData = {
      reminderTimestamp: parsedDate.getTime()
    }

    await RemindMeFormDataFlow.setDataAfterTimeInput(context, data)
    context.ui.showForm(timeConfirmationForm, data)
  }
)

Devvit.addMenuItem({
  label: "Remind me",
  location: "post",
  onPress: (_, context) => {
    context.ui.showForm(timeInputForm)
  }
})

export default Devvit
