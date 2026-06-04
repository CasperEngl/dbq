import Foundation
import LocalAuthentication

let reason = CommandLine.arguments.dropFirst().joined(separator: " ")

if reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
  fputs("Missing authentication reason\n", stderr)
  exit(64)
}

let context = LAContext()
context.localizedCancelTitle = "Cancel query"
context.touchIDAuthenticationAllowableReuseDuration = 0

var error: NSError?

guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
  fputs((error?.localizedDescription ?? "Device owner authentication is unavailable") + "\n", stderr)
  exit(1)
}

let semaphore = DispatchSemaphore(value: 0)
var authenticated = false
var authenticationError: Error?

context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
  authenticated = success
  authenticationError = error
  semaphore.signal()
}

semaphore.wait()

if authenticated {
  exit(0)
}

fputs((authenticationError?.localizedDescription ?? "Authentication denied") + "\n", stderr)
exit(1)
