import { ConfigValidationError } from "../errors/errors.js"
import { sanitizeNamePart } from "./database-name.js"
import { assertComposeProjectName } from "./safety.js"

export const deriveComposeProjectName = (projectId: string, databaseName: string): string => {
  const id = sanitizeNamePart(projectId)
  const name = [id, databaseName].filter((part) => part.length > 0).join("_")
  if (id.length === 0) {
    throw new ConfigValidationError({ issues: [`project.id "${projectId}" sanitizes to an empty compose project name`] })
  }
  return assertComposeProjectName(name)
}
