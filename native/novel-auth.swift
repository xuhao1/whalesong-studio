// SPDX-License-Identifier: LGPL-3.0-or-later
//
// novel-auth — asks the person at this Mac to prove they are its owner, with
// Touch ID or, failing that, the Mac's own password. Novel Studio runs it
// before it takes a locked book's key out of the login keychain.
//
//   novel-auth check              prints {"ok":…,"biometrics":…} and exits 0
//   novel-auth confirm <reason>   shows the system prompt; exits 0 when the
//                                 owner confirmed, 1 when they did not
//
// It holds no secret and reads none: all it ever answers is yes or no.
import Foundation
import LocalAuthentication

let arguments = CommandLine.arguments
let command = arguments.count > 1 ? arguments[1] : ""

func say(_ text: String) {
    FileHandle.standardOutput.write((text + "\n").data(using: .utf8)!)
}

switch command {
case "check":
    let context = LAContext()
    var failure: NSError?
    let owner = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &failure)
    let biometrics = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &failure)
    say("{\"ok\":\(owner),\"biometrics\":\(biometrics)}")
    exit(0)
case "confirm":
    let reason = arguments.count > 2 ? arguments[2] : "continue"
    let context = LAContext()
    let done = DispatchSemaphore(value: 0)
    var confirmed = false
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
        confirmed = success
        done.signal()
    }
    done.wait()
    exit(confirmed ? 0 : 1)
default:
    FileHandle.standardError.write("usage: novel-auth check | confirm <reason>\n".data(using: .utf8)!)
    exit(2)
}
