import CryptoKit
import Foundation
import RealityKit
import XCTest
@testable import Voice_VAC

@MainActor
final class RealityAssetContractTests: XCTestCase {
    private static let runtimeNodes: Set<String> = [
        "VAC_DEVICE_ROOT",
        "VAC_PORT",
        "VAC_NOZZLE",
        "VAC_NOZZLE_TIP",
        "VAC_BUTTON_BASE",
        "VAC_BUTTON_CAP",
        "VAC_HOSE_ROOT",
        "VAC_HOSE_SKIN",
    ]

    private static let jointNames = (0..<64).map { String(format: "VAC_HOSE_JOINT_%02d", $0) }
    private static let requiredPoseNames: Set<String> = [
        "nozzleDocked",
        "nozzleLiftRotate",
        "nozzleDeployed",
        "nozzleAttachmentCompression",
        "buttonUp",
        "buttonReady",
        "buttonDown",
        "buttonPaused",
    ]

    func testBundledContractDescribesStaticRestExportsAndNamedRuntimePoses() throws {
        let contract = try loadContract()

        XCTAssertEqual(contract.schemaVersion, 2)
        XCTAssertEqual(contract.product, "Voice VAC")
        XCTAssertEqual(contract.units, .init(linear: "meter", metersPerUnit: 1))
        XCTAssertEqual(contract.axes, .init(forward: "-Z", up: "Y", authoringUp: "Z"))
        XCTAssertEqual(Set(contract.runtimeNodes), Self.runtimeNodes)
        XCTAssertEqual(contract.joints, Self.jointNames)
        XCTAssertEqual(contract.buttonTravelMeters, 0.009, accuracy: 0.000_001)
        XCTAssertEqual(Set(contract.localBounds.keys), Self.runtimeNodes)
        XCTAssertFalse(contract.materials.isEmpty)

        XCTAssertEqual(contract.runtimePoseDelivery.mode, "namedTransforms")
        XCTAssertFalse(contract.runtimePoseDelivery.usdzAnimationTimeSamples)
        XCTAssertEqual(Set(contract.runtimePoseDelivery.namedPoses.keys), Self.requiredPoseNames)
        XCTAssertEqual(contract.runtimePoseDelivery.namedPoses["nozzleDocked"]?.transform, contract.nominalDockTransform)
        XCTAssertEqual(contract.runtimePoseDelivery.namedPoses["nozzleDocked"]?.transform, contract.nozzlePivot)
        XCTAssertEqual(contract.runtimePoseDelivery.namedPoses["nozzleDocked"]?.node, "VAC_NOZZLE")
        XCTAssertEqual(contract.runtimePoseDelivery.namedPoses["buttonUp"]?.node, "VAC_BUTTON_CAP")
        XCTAssertEqual(contract.hoseRuntime?.renderer, "metalSkinning")
        XCTAssertEqual(contract.hoseRuntime?.realityKitSkeletonTokensAreEntities, false)

        for (name, pose) in contract.runtimePoseDelivery.namedPoses {
            XCTAssertGreaterThan(pose.frame, 0, "\(name) must point to a real Blender keyframe")
            XCTAssertEqual(pose.transform.translation.count, 3)
            XCTAssertEqual(pose.transform.rotationQuaternion.count, 4)
            XCTAssertEqual(pose.transform.scale.count, 3)
            XCTAssertTrue(pose.transform.allValues.allSatisfy(\.isFinite))
        }

        XCTAssertNotEqual(
            contract.runtimePoseDelivery.namedPoses["nozzleDocked"]?.transform,
            contract.runtimePoseDelivery.namedPoses["nozzleDeployed"]?.transform
        )
        XCTAssertNotEqual(
            contract.runtimePoseDelivery.namedPoses["buttonUp"]?.transform,
            contract.runtimePoseDelivery.namedPoses["buttonDown"]?.transform
        )
        XCTAssertEqual(contract.reproducibility.mode, "semantic-contract-v1")
        XCTAssertEqual(contract.reproducibility.sceneSemanticSHA256.count, 64)
    }

    func testBundledDeviceUsesVacuumMaterialsInsteadOfOrnamentalBrass() throws {
        let contract = try loadContract()

        XCTAssertFalse(contract.materials.contains("MAT_BRASS_ACCENT"))
        XCTAssertFalse(contract.materials.contains { $0.localizedCaseInsensitiveContains("brass") })
        XCTAssertTrue(contract.materials.contains("MAT_TOY_IVORY"))
        XCTAssertTrue(contract.materials.contains("MAT_TOY_IVORY_RIBBED"))
    }

    func testBundledNozzleHasTwoToyEyes() throws {
        let nozzleURL = try XCTUnwrap(Bundle.main.url(forResource: "VoiceVACDevice", withExtension: "usdz"))
        let usdText = try usdCat(nozzleURL)

        XCTAssertTrue(usdText.contains("VAC_NOZZLE_EYE_L"))
        XCTAssertTrue(usdText.contains("VAC_NOZZLE_EYE_R"))
    }

    func testBundledUSDZIntegrityHierarchyAndStaticRestPose() async throws {
        let contract = try loadContract()
        let expectations: [String: Set<String>] = [
            "VoiceVACDevice": [
                "VAC_DEVICE_ROOT", "VAC_PORT", "VAC_NOZZLE", "VAC_NOZZLE_TIP",
                "VAC_BUTTON_BASE", "VAC_BUTTON_CAP",
            ],
            "VoiceVACHose": ["VAC_HOSE_ROOT", "VAC_HOSE_SKIN"],
        ]

        for (resource, expectedNodes) in expectations {
            let filename = "\(resource).usdz"
            let url = try XCTUnwrap(Bundle.main.url(forResource: resource, withExtension: "usdz"))
            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            let export = try XCTUnwrap(contract.exports[filename])
            XCTAssertEqual(data.count, export.byteCount)
            XCTAssertEqual(sha256(data), export.sha256)
            XCTAssertGreaterThan(data.count, 1_024)
            XCTAssertEqual(Array(data.prefix(4)), [0x50, 0x4b, 0x03, 0x04])

            let entity = try await Entity(contentsOf: url)
            let recursiveNames = Set(entity.recursiveEntityNames)
            XCTAssertTrue(expectedNodes.isSubset(of: recursiveNames), "\(filename) hierarchy missing \(expectedNodes.subtracting(recursiveNames))")

            let usdText = try usdCat(url)
            XCTAssertFalse(usdText.contains("timeSamples"), "\(filename) promises a static rest export")
            if resource == "VoiceVACHose" {
                XCTAssertTrue(usdText.contains("SkelBindingAPI"))
                XCTAssertTrue(usdText.contains("primvars:skel:jointIndices"))
                XCTAssertTrue(usdText.contains("primvars:skel:jointWeights"))
                for joint in Self.jointNames {
                    XCTAssertTrue(usdText.contains(joint), "USDZ skeleton missing \(joint)")
                    XCTAssertNil(entity.findEntity(named: joint), "USD skeleton tokens are not RealityKit Entity controls")
                }
            }
        }

        let deviceURL = try XCTUnwrap(Bundle.main.url(forResource: "VoiceVACDevice", withExtension: "usdz"))
        let device = try await Entity(contentsOf: deviceURL)
        let nozzle = try XCTUnwrap(device.findEntity(named: "VAC_NOZZLE"))
        let button = try XCTUnwrap(device.findEntity(named: "VAC_BUTTON_CAP"))
        let dock = try XCTUnwrap(contract.runtimePoseDelivery.namedPoses["nozzleDocked"])
        let buttonUp = try XCTUnwrap(contract.runtimePoseDelivery.namedPoses["buttonUp"])
        assertRealityTransform(nozzle.transform, matches: dock.transform, accuracy: 0.000_1)
        assertRealityTransform(button.transform, matches: buttonUp.transform, accuracy: 0.000_1)
    }

    func testBundledMetalHoseAssetParsesValidatedSchemaAndContract() throws {
        let contract = try loadContract()
        let metal = try XCTUnwrap(contract.hoseRuntime)
        XCTAssertEqual(metal.renderer, "metalSkinning")
        XCTAssertEqual(metal.binary.schema, "VoiceVACHoseMesh")
        XCTAssertEqual(metal.binary.version, 1)
        XCTAssertEqual(metal.binary.endianness, "little")
        XCTAssertEqual(metal.binary.headerByteCount, 160)
        XCTAssertEqual(metal.binary.positionComponentType, "float32")
        XCTAssertEqual(metal.binary.indexComponentType, "uint32")
        XCTAssertEqual(metal.binary.jointIndexComponentType, "uint16")
        XCTAssertEqual(metal.binary.matrixLayout, "columnMajor4x4")
        XCTAssertEqual(metal.binary.sections["positionsOffset"], 160)
        XCTAssertEqual(metal.binary.jointCount, 64)
        XCTAssertEqual(metal.binary.maxInfluencesPerVertex, 2)
        XCTAssertEqual(metal.binary.correctiveBlendShapes.map(\.name), ["bendPositive", "bendNegative"])

        let url = try XCTUnwrap(Bundle.main.url(forResource: "VoiceVACHose", withExtension: "meshbin"))
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        let asset = try HoseMetalAsset(data: data, expectedSHA256: metal.binary.sha256)

        XCTAssertEqual(data.count, metal.binary.byteCount)
        XCTAssertEqual(asset.schemaVersion, 1)
        XCTAssertEqual(asset.positions.count, metal.binary.vertexCount)
        XCTAssertEqual(asset.normals.count, asset.positions.count)
        XCTAssertEqual(asset.textureCoordinates.count, asset.positions.count)
        XCTAssertEqual(asset.jointIndices.count, asset.positions.count)
        XCTAssertEqual(asset.jointWeights.count, asset.positions.count)
        XCTAssertEqual(asset.indices.count, metal.binary.indexCount)
        XCTAssertEqual(asset.bindMatrices.count, 64)
        XCTAssertEqual(asset.inverseBindMatrices.count, 64)
        XCTAssertEqual(asset.correctiveDeltas.count, 2)
        XCTAssertTrue(asset.correctiveDeltas.allSatisfy { $0.count == asset.positions.count })
        XCTAssertTrue(asset.indices.allSatisfy { Int($0) < asset.positions.count })
        XCTAssertTrue(asset.jointIndices.allSatisfy { $0.x < 64 && $0.y < 64 })
        XCTAssertTrue(asset.jointWeights.allSatisfy { abs(($0.x + $0.y) - 1) < 0.000_01 })
        XCTAssertEqual(asset.material.baseColor.count, 4)
        for (actual, expected) in zip(asset.bounds.minimum, metal.binary.bounds.min) {
            XCTAssertEqual(actual, Float(expected), accuracy: 0.000_001)
        }
        for (actual, expected) in zip(asset.bounds.maximum, metal.binary.bounds.max) {
            XCTAssertEqual(actual, Float(expected), accuracy: 0.000_001)
        }
    }

    func testCPUReferenceSkinningMovesWeightedMiddleVerticesAndKeepsEndpointsStable() throws {
        let contract = try loadContract()
        let metal = try XCTUnwrap(contract.hoseRuntime)
        let url = try XCTUnwrap(Bundle.main.url(forResource: "VoiceVACHose", withExtension: "meshbin"))
        let asset = try HoseMetalAsset(
            data: Data(contentsOf: url, options: .mappedIfSafe),
            expectedSHA256: metal.binary.sha256
        )
        let movedJoint = 32
        let displacement = SIMD3<Float>(0.031, -0.017, 0.009)
        var pose = asset.bindMatrices
        pose[movedJoint] = simd_float4x4(translation: displacement) * pose[movedJoint]
        let deformed = try asset.referenceSkinnedPositions(jointMatrices: pose)

        let affected = asset.jointIndices.indices.filter { index in
            (Int(asset.jointIndices[index].x) == movedJoint && asset.jointWeights[index].x > 0)
                || (Int(asset.jointIndices[index].y) == movedJoint && asset.jointWeights[index].y > 0)
        }
        XCTAssertFalse(affected.isEmpty)
        XCTAssertTrue(affected.contains { simd_length(deformed[$0] - asset.positions[$0]) > 0.000_1 })

        for index in [0, asset.positions.count - 1] {
            XCTAssertEqual(deformed[index].x, asset.positions[index].x, accuracy: 0.000_001)
            XCTAssertEqual(deformed[index].y, asset.positions[index].y, accuracy: 0.000_001)
            XCTAssertEqual(deformed[index].z, asset.positions[index].z, accuracy: 0.000_001)
        }
    }

    func testMetalHoseLoaderRejectsMissingTruncatedBadHashAndOutOfRangeIndex() throws {
        XCTAssertThrowsError(try HoseMetalAsset.loadBundled(resource: "DefinitelyMissing", bundle: .main)) {
            XCTAssertEqual($0 as? HoseMetalAssetError, .missingResource("DefinitelyMissing.meshbin"))
        }

        let url = try XCTUnwrap(Bundle.main.url(forResource: "VoiceVACHose", withExtension: "meshbin"))
        let valid = try Data(contentsOf: url)
        XCTAssertThrowsError(try HoseMetalAsset(data: valid, expectedSHA256: String(repeating: "0", count: 64))) {
            XCTAssertEqual($0 as? HoseMetalAssetError, .fileHashMismatch)
        }
        XCTAssertThrowsError(try HoseMetalAsset(data: Data(valid.prefix(80)))) {
            XCTAssertEqual($0 as? HoseMetalAssetError, .truncatedHeader)
        }

        var badHash = valid
        badHash[112] ^= 0xff
        XCTAssertThrowsError(try HoseMetalAsset(data: badHash)) {
            XCTAssertEqual($0 as? HoseMetalAssetError, .payloadHashMismatch)
        }

        var badLayout = valid
        badLayout.writeLittleEndianUInt32(UInt32.max, at: 40)
        XCTAssertThrowsError(try HoseMetalAsset(data: badLayout)) {
            XCTAssertEqual($0 as? HoseMetalAssetError, .invalidLayout)
        }

        let parsed = try HoseMetalAsset(data: valid)
        var badIndex = valid
        badIndex.writeLittleEndianUInt32(UInt32(parsed.positions.count), at: parsed.layout.indicesOffset)
        badIndex.refreshMeshPayloadHash()
        XCTAssertThrowsError(try HoseMetalAsset(data: badIndex)) {
            XCTAssertEqual($0 as? HoseMetalAssetError, .indexOutOfRange)
        }

        var badJoint = valid
        badJoint.writeLittleEndianUInt16(64, at: parsed.layout.jointIndicesOffset)
        badJoint.refreshMeshPayloadHash()
        XCTAssertThrowsError(try HoseMetalAsset(data: badJoint)) {
            XCTAssertEqual($0 as? HoseMetalAssetError, .jointIndexOutOfRange)
        }

        var inconsistentBindPair = valid
        inconsistentBindPair.writeLittleEndianFloat(2, at: parsed.layout.bindMatricesOffset)
        inconsistentBindPair.refreshMeshPayloadHash()
        XCTAssertThrowsError(try HoseMetalAsset(data: inconsistentBindPair)) {
            XCTAssertEqual($0 as? HoseMetalAssetError, .invalidJointMatrix)
        }
    }

    private func loadContract() throws -> AssetContract {
        let contractURL = try XCTUnwrap(Bundle.main.url(forResource: "asset-contract", withExtension: "json"))
        return try JSONDecoder().decode(AssetContract.self, from: Data(contentsOf: contractURL))
    }

    private func usdCat(_ url: URL) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/usdcat")
        process.arguments = [url.path]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        let output = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, String(decoding: output, as: UTF8.self))
        return String(decoding: output, as: UTF8.self)
    }

    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func assertRealityTransform(
        _ actual: Transform,
        matches expected: AssetTransform,
        accuracy: Float,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let translation = actual.translation
        XCTAssertEqual(translation.x, Float(expected.translation[0]), accuracy: accuracy, file: file, line: line)
        XCTAssertEqual(translation.y, Float(expected.translation[1]), accuracy: accuracy, file: file, line: line)
        XCTAssertEqual(translation.z, Float(expected.translation[2]), accuracy: accuracy, file: file, line: line)
        XCTAssertEqual(actual.scale.x, Float(expected.scale[0]), accuracy: accuracy, file: file, line: line)
        XCTAssertEqual(actual.scale.y, Float(expected.scale[1]), accuracy: accuracy, file: file, line: line)
        XCTAssertEqual(actual.scale.z, Float(expected.scale[2]), accuracy: accuracy, file: file, line: line)

        let expectedRotation = simd_quatf(
            ix: Float(expected.rotationQuaternion[1]),
            iy: Float(expected.rotationQuaternion[2]),
            iz: Float(expected.rotationQuaternion[3]),
            r: Float(expected.rotationQuaternion[0])
        )
        XCTAssertGreaterThan(abs(simd_dot(actual.rotation.vector, expectedRotation.vector)), 1 - accuracy, file: file, line: line)
    }
}

private struct AssetContract: Decodable {
    let schemaVersion: Int
    let product: String
    let units: Units
    let axes: Axes
    let runtimeNodes: [String]
    let joints: [String]
    let materials: [String]
    let localBounds: [String: Bounds]
    let nominalDockTransform: AssetTransform
    let nozzlePivot: AssetTransform
    let buttonTravelMeters: Double
    let runtimePoseDelivery: RuntimePoseDelivery
    let reproducibility: Reproducibility
    let exports: [String: ExportIntegrity]
    let hoseRuntime: HoseRuntimeContract?
}

private struct HoseRuntimeContract: Decodable {
    let renderer: String
    let realityKitSkeletonTokensAreEntities: Bool
    let binary: HoseBinaryContract
}

private struct HoseBinaryContract: Decodable {
    let schema: String
    let version: Int
    let endianness: String
    let headerByteCount: Int
    let positionComponentType: String
    let indexComponentType: String
    let jointIndexComponentType: String
    let matrixLayout: String
    let sha256: String
    let byteCount: Int
    let vertexCount: Int
    let indexCount: Int
    let jointCount: Int
    let maxInfluencesPerVertex: Int
    let correctiveBlendShapes: [CorrectiveBlendShapeContract]
    let bounds: Bounds
    let sections: [String: Int]
}

private struct CorrectiveBlendShapeContract: Decodable {
    let name: String
    let index: Int
}

private struct Units: Codable, Equatable {
    let linear: String
    let metersPerUnit: Double
}

private struct Axes: Codable, Equatable {
    let forward: String
    let up: String
    let authoringUp: String
}

private struct Bounds: Decodable {
    let min: [Double]
    let max: [Double]
}

private struct RuntimePoseDelivery: Decodable {
    let mode: String
    let usdzAnimationTimeSamples: Bool
    let namedPoses: [String: NamedPose]
}

private struct NamedPose: Decodable {
    let node: String
    let action: String
    let frame: Int
    let transform: AssetTransform
}

private struct AssetTransform: Codable, Equatable {
    let translation: [Double]
    let rotationQuaternion: [Double]
    let scale: [Double]

    var allValues: [Double] { translation + rotationQuaternion + scale }
}

private struct Reproducibility: Decodable {
    let mode: String
    let sceneSemanticSHA256: String
}

private struct ExportIntegrity: Decodable {
    let sha256: String
    let byteCount: Int
}

private extension Entity {
    var recursiveEntityNames: [String] {
        [name] + children.flatMap(\.recursiveEntityNames)
    }
}

private extension simd_float4x4 {
    init(translation: SIMD3<Float>) {
        self = matrix_identity_float4x4
        columns.3 = SIMD4<Float>(translation, 1)
    }
}

private extension Data {
    mutating func writeLittleEndianUInt16(_ value: UInt16, at offset: Int) {
        var value = value.littleEndian
        Swift.withUnsafeBytes(of: &value) { replaceSubrange(offset..<(offset + 2), with: $0) }
    }

    mutating func writeLittleEndianUInt32(_ value: UInt32, at offset: Int) {
        var value = value.littleEndian
        Swift.withUnsafeBytes(of: &value) { replaceSubrange(offset..<(offset + 4), with: $0) }
    }

    mutating func writeLittleEndianFloat(_ value: Float, at offset: Int) {
        writeLittleEndianUInt32(value.bitPattern, at: offset)
    }

    mutating func refreshMeshPayloadHash() {
        let payloadOffset = Int(readLittleEndianUInt32(at: 80))
        let payloadByteCount = Int(readLittleEndianUInt32(at: 84))
        let digest = Data(SHA256.hash(data: self[payloadOffset..<(payloadOffset + payloadByteCount)]))
        replaceSubrange(112..<144, with: digest)
    }

    func readLittleEndianUInt32(at offset: Int) -> UInt32 {
        withUnsafeBytes { rawBuffer in
            UInt32(littleEndian: rawBuffer.loadUnaligned(fromByteOffset: offset, as: UInt32.self))
        }
    }
}
