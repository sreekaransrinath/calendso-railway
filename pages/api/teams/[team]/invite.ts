import { randomBytes } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";

import { getSession } from "@lib/auth";
import { createInvitationEmail } from "@lib/emails/invitation";
import prisma from "@lib/prisma";

import { getTranslation } from "@server/lib/i18n";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const t = await getTranslation(req.body.language ?? "en", "common");

  if (req.method !== "POST") {
    return res.status(400).json({ message: "Bad request" });
  }

  const session = await getSession({ req: req });
  if (!session) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const team = await prisma.team.findFirst({
    where: {
      id: parseInt(req.query.team as string),
    },
  });

  if (!team) {
    return res.status(404).json({ message: "Invalid team" });
  }

  const invitee = await prisma.user.findFirst({
    where: {
      OR: [{ username: req.body.usernameOrEmail }, { email: req.body.usernameOrEmail }],
    },
  });

  if (!invitee) {
    // liberal email match
    const isEmail = (str: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);

    if (!isEmail(req.body.usernameOrEmail)) {
      return res.status(400).json({
        message: `Invite failed because there is no corresponding user for ${req.body.usernameOrEmail}`,
      });
    }
    // valid email given, create User
    await prisma.user
      .create({
        data: {
          email: req.body.usernameOrEmail,
        },
      })
      .then((invitee) =>
        prisma.membership.create({
          data: {
            teamId: parseInt(req.query.team as string),
            userId: invitee.id,
            role: req.body.role,
          },
        })
      );

    const token: string = randomBytes(32).toString("hex");

    await prisma.verificationRequest.create({
      data: {
        identifier: req.body.usernameOrEmail,
        token,
        expires: new Date(new Date().setHours(168)), // +1 week
      },
    });

    if (session?.user?.name && team?.name) {
      createInvitationEmail({
        language: t,
        toEmail: req.body.usernameOrEmail,
        from: session.user.name,
        teamName: team.name,
        token,
      });
    }

    return res.status(201).json({});
  }

  // create provisional membership
  try {
    await prisma.membership.create({
      data: {
        teamId: parseInt(req.query.team as string),
        userId: invitee.id,
        role: req.body.role,
      },
    });
  } catch (err: any) {
    if (err.code === "P2002") {
      // unique constraint violation
      return res.status(409).json({
        message: "This user is a member of this team / has a pending invitation.",
      });
    } else {
      throw err; // rethrow
    }
  }

  // inform user of membership by email
  if (req.body.sendEmailInvitation && session?.user?.name && team?.name) {
    createInvitationEmail({
      language: t,
      toEmail: invitee.email,
      from: session.user.name,
      teamName: team.name,
    });
  }

  res.status(201).json({});
}
