import { z } from "zod";

export const bitbucketRepositorySchema = z.looseObject({
  uuid: z.string().min(1),
  name: z.string().min(1),
  full_name: z.string().min(1),
  slug: z.string().min(1),
  links: z.looseObject({ html: z.looseObject({ href: z.string().url() }) }),
});
