import ExpoModulesCore
import UIKit

// UIKit owns the word recognizer, drag handles, edit menu and Copy operation.
final class MessageTextView: ExpoView, UITextViewDelegate {
  let textView = UITextView(frame: .zero)
  let onContentSize = EventDispatcher()
  let onLinkPress = EventDispatcher()
  let onSelectionChange = EventDispatcher()
  let onFontError = EventDispatcher()
  private var contentIdentity = ""
  private var lastMeasurement = CGSize.zero
  private var applyingContent = false
  private var lastRange = NSRange(location: NSNotFound, length: 0)

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    textView.isEditable = false
    textView.isSelectable = true
    textView.isScrollEnabled = false
    textView.backgroundColor = .clear
    textView.attributedText = NSAttributedString(string: "")
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.dataDetectorTypes = []
    textView.adjustsFontForContentSizeCategory = false
    textView.linkTextAttributes = [:]
    textView.delegate = self
    addSubview(textView)
  }

  func setContentIdentity(_ identity: String) {
    guard contentIdentity != identity else { return }
    contentIdentity = identity
    // A recycled row cannot retain another row's selection, even with equal text.
    applyingContent = true
    textView.selectedRange = NSRange(location: 0, length: 0)
    applyingContent = false
    lastRange = NSRange(location: NSNotFound, length: 0)
    lastMeasurement = .zero
    setNeedsLayout()
  }

  private func color(_ raw: String) -> UIColor {
    let value = raw.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    guard let hex = UInt64(value, radix: 16), value.count == 6 || value.count == 8 else { return .label }
    let rgba = value.count == 6 ? (hex << 8) | 255 : hex
    return UIColor(red: CGFloat((rgba >> 24) & 255) / 255,
                   green: CGFloat((rgba >> 16) & 255) / 255,
                   blue: CGFloat((rgba >> 8) & 255) / 255,
                   alpha: CGFloat(rgba & 255) / 255)
  }

  private func font(_ run: MessageTextRun) -> UIFont {
    let size = CGFloat(run.fontSize)
    var resolved: UIFont
    if let family = run.fontFamily, !family.isEmpty {
      // expo-font swizzles this lookup to resolve its JS aliases to PostScript names.
      let names = UIFont.fontNames(forFamilyName: family)
      if let font = (names.first.flatMap { UIFont(name: $0, size: size) } ?? UIFont(name: family, size: size)) {
        resolved = font
      } else {
        // Report a missing font explicitly; native Release proof must reject this event.
        onFontError(["fontFamily": family])
        resolved = UIFont.systemFont(ofSize: size)
      }
    } else { resolved = UIFont.systemFont(ofSize: size) }
    if run.italic, let descriptor = resolved.fontDescriptor.withSymbolicTraits(resolved.fontDescriptor.symbolicTraits.union(.traitItalic)) {
      resolved = UIFont(descriptor: descriptor, size: size)
    }
    return resolved
  }

  func setRuns(_ runs: [MessageTextRun]) {
    let value = NSMutableAttributedString(string: "")
    for run in runs {
      let paragraph = NSMutableParagraphStyle()
      paragraph.minimumLineHeight = CGFloat(run.lineHeight)
      paragraph.maximumLineHeight = CGFloat(run.lineHeight)
      paragraph.alignment = run.alignment == "right" ? .right : run.alignment == "center" ? .center : .left
      var attributes: [NSAttributedString.Key: Any] = [
        .font: font(run), .foregroundColor: color(run.color), .paragraphStyle: paragraph
      ]
      if let background = run.backgroundColor { attributes[.backgroundColor] = color(background) }
      if run.underline { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
      if let href = run.href { attributes[.link] = href }
      // NSAttributedString computes UTF-16 ranges; no Swift grapheme/JS offset mixing.
      value.append(NSAttributedString(string: run.text, attributes: attributes))
    }
    guard textView.attributedText?.isEqual(to: value) != true else { return }
    let sameText = textView.text == value.string
    let selected = textView.selectedRange
    applyingContent = true
    textView.attributedText = value
    textView.selectedRange = sameText && NSMaxRange(selected) <= value.length ? selected : NSRange(location: 0, length: 0)
    applyingContent = false
    lastRange = NSRange(location: NSNotFound, length: 0)
    lastMeasurement = .zero
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    guard bounds.width > 0 else { return }
    let measured = textView.sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude))
    let size = CGSize(width: bounds.width, height: ceil(measured.height))
    if size != lastMeasurement {
      lastMeasurement = size
      let natural = textView.attributedText.boundingRect(
        with: CGSize(width: 100_000, height: CGFloat.greatestFiniteMagnitude),
        options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
      onContentSize(["width": size.width, "height": size.height,
                     "naturalWidth": max(1, ceil(natural.width)), "contentIdentity": contentIdentity])
    }
  }

  func textViewDidChangeSelection(_ textView: UITextView) {
    guard !applyingContent else { return }
    let range = textView.selectedRange
    guard range.location != NSNotFound, range != lastRange else { return }
    lastRange = range
    onSelectionChange(["start": range.location, "end": NSMaxRange(range), "length": range.length])
  }

  @available(iOS 17.0, *)
  func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
    guard let url = textItem.link else { return defaultAction }
    let href = textView.attributedText.attribute(.link, at: textItem.range.location, effectiveRange: nil) as? String ?? url.absoluteString
    return UIAction(title: defaultAction.title, image: defaultAction.image) { [weak self] _ in
      self?.onLinkPress(["href": href])
    }
  }

  func textView(_ textView: UITextView, shouldInteractWith URL: URL, in characterRange: NSRange,
                interaction: UITextItemInteraction) -> Bool {
    if interaction == .invokeDefaultAction {
      let explicitHref = textView.attributedText.attribute(.link, at: characterRange.location, effectiveRange: nil) as? String
      onLinkPress(["href": explicitHref ?? URL.absoluteString])
    }
    return false
  }
}
