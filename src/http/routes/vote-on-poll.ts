import { randomUUID } from 'node:crypto'
import { FastifyInstance } from 'fastify'
import z from 'zod'

import { prisma } from '@/lib/prisma'
import { redis } from '@/lib/redis'
import { voting } from '@/utils/voting-pub-sub'

export async function voteOnPoll(app: FastifyInstance) {
  app.post('/polls/:pollId/votes', async (request, reply) => {
    const voteOnPollBody = z.object({
      pollOptionId: z.string().uuid(),
    })

    const voteOnPollParams = z.object({
      pollId: z.string().uuid(),
    })

    const { pollId } = voteOnPollParams.parse(request.params)
    const { pollOptionId } = voteOnPollBody.parse(request.body)

    let { sessionId } = request.cookies

    if (sessionId) {
      const userPreviousVoteOnPoll = await prisma.vote.findUnique({
        where: {
          session_id_poll_id: {
            session_id: sessionId,
            poll_id: pollId,
          },
        },
      })

      if (
        userPreviousVoteOnPoll &&
        userPreviousVoteOnPoll.poll_option_id !== pollOptionId
      ) {
        await prisma.vote.delete({
          where: {
            id: userPreviousVoteOnPoll.id,
          },
        })

        const votes = await redis.zincrby(
          pollId,
          -1,
          userPreviousVoteOnPoll.poll_option_id,
        )

        voting.publish(pollId, {
          pollOptionId: userPreviousVoteOnPoll.poll_option_id,
          votes: Number(votes),
        })
      } else if (userPreviousVoteOnPoll) {
        return reply
          .status(400)
          .send({ message: 'You already voted on this poll' })
      }
    }

    if (!sessionId) {
      sessionId = randomUUID()

      reply.setCookie('sessionId', sessionId, {
        path: '/',
        maxAge: 60 * 60 * 24 * 30, // 30 days,
        signed: true,
        httpOnly: true,
      })
    }

    await prisma.vote.create({
      data: {
        session_id: sessionId,
        poll_id: pollId,
        poll_option_id: pollOptionId,
      },
    })

    const votes = await redis.zincrby(pollId, 1, pollOptionId)

    voting.publish(pollId, {
      pollOptionId,
      votes: Number(votes),
    })

    return reply.status(201).send()
  })
}
