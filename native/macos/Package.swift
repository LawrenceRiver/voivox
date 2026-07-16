// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "VOIVOXHost",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "voivox-host", targets: ["VOIVOXHost"]),
        .executable(name: "voivox-native-host", targets: ["VOIVOXNativeHost"])
    ],
    targets: [
        .executableTarget(
            name: "VOIVOXHost",
            swiftSettings: [.unsafeFlags(["-parse-as-library"])],
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("AppKit")
            ]
        ),
        .testTarget(name: "VOIVOXHostTests", dependencies: ["VOIVOXHost"]),
        .executableTarget(name: "VOIVOXNativeHost"),
        .testTarget(name: "VOIVOXNativeHostTests", dependencies: ["VOIVOXNativeHost"])
    ]
)
