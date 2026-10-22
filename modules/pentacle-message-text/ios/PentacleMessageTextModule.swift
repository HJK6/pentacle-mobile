import ExpoModulesCore

struct MessageTextRun: Record {
  @Field var text: String = ""
  @Field var fontFamily: String? = nil
  @Field var fontSize: Double = 14.5
  @Field var lineHeight: Double = 22
  @Field var color: String = "#ffffff"
  @Field var backgroundColor: String? = nil
  @Field var italic: Bool = false
  @Field var underline: Bool = false
  @Field var href: String? = nil
  @Field var alignment: String = "left"
}

public class PentacleMessageTextModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PentacleMessageText")
    View(MessageTextView.self) {
      Events("onContentSize", "onLinkPress", "onSelectionChange", "onFontError")
      Prop("runs") { (view: MessageTextView, runs: [MessageTextRun]) in view.setRuns(runs) }
      Prop("contentIdentity") { (view: MessageTextView, identity: String) in view.setContentIdentity(identity) }
      Prop("textIdentifier") { (view: MessageTextView, value: String) in view.textView.accessibilityIdentifier = value }
    }
  }
}
