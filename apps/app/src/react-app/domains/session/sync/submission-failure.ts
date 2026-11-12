import { z } from "zod";

export const submissionFailureSchema = z.object({ message: z.string() });
export type SubmissionFailure = z.infer<typeof submissionFailureSchema>;
