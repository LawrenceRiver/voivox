import CryptoKit
import Foundation
import simd

enum HoseMetalAssetError: Error, Equatable {
    case missingResource(String)
    case truncatedHeader
    case invalidMagic
    case unsupportedVersion(UInt32)
    case wrongEndianness
    case invalidLayout
    case payloadHashMismatch
    case fileHashMismatch
    case invalidVertex
    case invalidNormal
    case invalidWeight
    case jointIndexOutOfRange
    case indexOutOfRange
    case invalidJointMatrix
    case invalidMaterial
    case invalidJointMatrixCount
}

struct HoseMetalAsset {
    static let magic = Data([0x56, 0x41, 0x43, 0x48, 0x4f, 0x53, 0x45, 0x00]) // VACHOSE\0
    static let supportedVersion: UInt32 = 1
    static let littleEndianMarker: UInt32 = 0x0102_0304
    static let fixedHeaderByteCount = 160
    static let requiredJointCount = 64
    static let requiredCorrectiveCount = 2

    struct Layout: Equatable {
        let positionsOffset: Int
        let normalsOffset: Int
        let textureCoordinatesOffset: Int
        let jointIndicesOffset: Int
        let jointWeightsOffset: Int
        let indicesOffset: Int
        let bindMatricesOffset: Int
        let inverseBindMatricesOffset: Int
        let correctiveDeltasOffset: Int
        let materialOffset: Int
        let payloadOffset: Int
        let payloadByteCount: Int
    }

    struct Bounds: Equatable {
        let minimum: [Float]
        let maximum: [Float]
    }

    struct Material: Equatable {
        let baseColor: [Float]
        let metallic: Float
        let roughness: Float
        let coatWeight: Float
        let coatRoughness: Float
    }

    let schemaVersion: UInt32
    let positions: [SIMD3<Float>]
    let normals: [SIMD3<Float>]
    let textureCoordinates: [SIMD2<Float>]
    let jointIndices: [SIMD2<UInt16>]
    let jointWeights: [SIMD2<Float>]
    let indices: [UInt32]
    let bindMatrices: [simd_float4x4]
    let inverseBindMatrices: [simd_float4x4]
    let correctiveDeltas: [[SIMD3<Float>]]
    let material: Material
    let bounds: Bounds
    let layout: Layout

    static func loadBundled(
        resource: String = "VoiceVACHose",
        bundle: Bundle = .main,
        expectedSHA256: String? = nil
    ) throws -> HoseMetalAsset {
        guard let url = bundle.url(forResource: resource, withExtension: "meshbin") else {
            throw HoseMetalAssetError.missingResource("\(resource).meshbin")
        }
        return try HoseMetalAsset(
            data: Data(contentsOf: url, options: .mappedIfSafe),
            expectedSHA256: expectedSHA256
        )
    }

    init(data: Data, expectedSHA256: String? = nil) throws {
        guard data.count >= Self.fixedHeaderByteCount else {
            throw HoseMetalAssetError.truncatedHeader
        }
        guard data.prefix(Self.magic.count) == Self.magic else {
            throw HoseMetalAssetError.invalidMagic
        }

        if let expectedSHA256, Self.sha256(data) != expectedSHA256.lowercased() {
            throw HoseMetalAssetError.fileHashMismatch
        }

        let version = data.uint32(at: 8)
        guard version == Self.supportedVersion else {
            throw HoseMetalAssetError.unsupportedVersion(version)
        }
        guard data.uint32(at: 12) == Self.littleEndianMarker else {
            throw HoseMetalAssetError.wrongEndianness
        }

        let headerByteCount = Int(data.uint32(at: 16))
        let fileByteCount = Int(data.uint32(at: 20))
        let vertexCount = Int(data.uint32(at: 24))
        let indexCount = Int(data.uint32(at: 28))
        let jointCount = Int(data.uint32(at: 32))
        let correctiveCount = Int(data.uint32(at: 36))
        let layout = Layout(
            positionsOffset: Int(data.uint32(at: 40)),
            normalsOffset: Int(data.uint32(at: 44)),
            textureCoordinatesOffset: Int(data.uint32(at: 48)),
            jointIndicesOffset: Int(data.uint32(at: 52)),
            jointWeightsOffset: Int(data.uint32(at: 56)),
            indicesOffset: Int(data.uint32(at: 60)),
            bindMatricesOffset: Int(data.uint32(at: 64)),
            inverseBindMatricesOffset: Int(data.uint32(at: 68)),
            correctiveDeltasOffset: Int(data.uint32(at: 72)),
            materialOffset: Int(data.uint32(at: 76)),
            payloadOffset: Int(data.uint32(at: 80)),
            payloadByteCount: Int(data.uint32(at: 84))
        )

        guard headerByteCount == Self.fixedHeaderByteCount,
              fileByteCount == data.count,
              vertexCount > 0, vertexCount <= 1_000_000,
              indexCount > 0, indexCount <= 6_000_000, indexCount.isMultiple(of: 3),
              jointCount == Self.requiredJointCount,
              correctiveCount == Self.requiredCorrectiveCount,
              data.uint32(at: 148) == 4,
              data.uint32(at: 152) == 2
        else {
            throw HoseMetalAssetError.invalidLayout
        }

        let expectedOffsets = try Self.expectedOffsets(
            vertexCount: vertexCount,
            indexCount: indexCount,
            jointCount: jointCount,
            correctiveCount: correctiveCount,
            headerByteCount: headerByteCount
        )
        guard layout == expectedOffsets, layout.payloadOffset == headerByteCount,
              Self.checkedAdd(layout.payloadOffset, layout.payloadByteCount) == data.count
        else {
            throw HoseMetalAssetError.invalidLayout
        }

        let storedPayloadHash = data.subdata(in: 112..<144)
        let payloadRange = layout.payloadOffset..<(layout.payloadOffset + layout.payloadByteCount)
        let actualPayloadHash = Data(SHA256.hash(data: data[payloadRange]))
        guard storedPayloadHash == actualPayloadHash else {
            throw HoseMetalAssetError.payloadHashMismatch
        }

        let bounds = Bounds(
            minimum: (0..<3).map { data.float32(at: 88 + $0 * 4) },
            maximum: (0..<3).map { data.float32(at: 100 + $0 * 4) }
        )
        guard bounds.minimum.allSatisfy(\.isFinite),
              bounds.maximum.allSatisfy(\.isFinite),
              zip(bounds.minimum, bounds.maximum).allSatisfy({ $0 <= $1 })
        else {
            throw HoseMetalAssetError.invalidVertex
        }

        var positions = [SIMD3<Float>]()
        var normals = [SIMD3<Float>]()
        var textureCoordinates = [SIMD2<Float>]()
        var jointIndices = [SIMD2<UInt16>]()
        var jointWeights = [SIMD2<Float>]()
        positions.reserveCapacity(vertexCount)
        normals.reserveCapacity(vertexCount)
        textureCoordinates.reserveCapacity(vertexCount)
        jointIndices.reserveCapacity(vertexCount)
        jointWeights.reserveCapacity(vertexCount)

        for index in 0..<vertexCount {
            let position = data.float3(at: layout.positionsOffset + index * 12)
            guard position.allFinite else { throw HoseMetalAssetError.invalidVertex }
            positions.append(position)

            let normal = data.float3(at: layout.normalsOffset + index * 12)
            guard normal.allFinite, simd_length_squared(normal) > 0.25 else {
                throw HoseMetalAssetError.invalidNormal
            }
            normals.append(normal)

            let uv = SIMD2<Float>(
                data.float32(at: layout.textureCoordinatesOffset + index * 8),
                data.float32(at: layout.textureCoordinatesOffset + index * 8 + 4)
            )
            guard uv.x.isFinite, uv.y.isFinite else { throw HoseMetalAssetError.invalidVertex }
            textureCoordinates.append(uv)

            let joints = SIMD2<UInt16>(
                data.uint16(at: layout.jointIndicesOffset + index * 4),
                data.uint16(at: layout.jointIndicesOffset + index * 4 + 2)
            )
            guard Int(joints.x) < jointCount, Int(joints.y) < jointCount else {
                throw HoseMetalAssetError.jointIndexOutOfRange
            }
            jointIndices.append(joints)

            let weights = SIMD2<Float>(
                data.float32(at: layout.jointWeightsOffset + index * 8),
                data.float32(at: layout.jointWeightsOffset + index * 8 + 4)
            )
            guard weights.x.isFinite, weights.y.isFinite,
                  weights.x >= 0, weights.y >= 0,
                  abs(weights.x + weights.y - 1) <= 0.000_1
            else {
                throw HoseMetalAssetError.invalidWeight
            }
            jointWeights.append(weights)
        }

        var indices = [UInt32]()
        indices.reserveCapacity(indexCount)
        for index in 0..<indexCount {
            let vertexIndex = data.uint32(at: layout.indicesOffset + index * 4)
            guard Int(vertexIndex) < vertexCount else { throw HoseMetalAssetError.indexOutOfRange }
            indices.append(vertexIndex)
        }

        let bindMatrices = try Self.readMatrices(data, offset: layout.bindMatricesOffset, count: jointCount)
        let inverseBindMatrices = try Self.readMatrices(data, offset: layout.inverseBindMatricesOffset, count: jointCount)
        for index in 0..<jointCount {
            let product = bindMatrices[index] * inverseBindMatrices[index]
            for column in 0..<4 {
                for row in 0..<4 {
                    let expected: Float = column == row ? 1 : 0
                    guard abs(product[column][row] - expected) <= 0.000_1 else {
                        throw HoseMetalAssetError.invalidJointMatrix
                    }
                }
            }
        }

        var correctiveDeltas = [[SIMD3<Float>]]()
        correctiveDeltas.reserveCapacity(correctiveCount)
        for correctiveIndex in 0..<correctiveCount {
            let base = layout.correctiveDeltasOffset + correctiveIndex * vertexCount * 12
            var deltas = [SIMD3<Float>]()
            deltas.reserveCapacity(vertexCount)
            for vertexIndex in 0..<vertexCount {
                let delta = data.float3(at: base + vertexIndex * 12)
                guard delta.allFinite else { throw HoseMetalAssetError.invalidVertex }
                deltas.append(delta)
            }
            correctiveDeltas.append(deltas)
        }

        let materialValues = (0..<8).map { data.float32(at: layout.materialOffset + $0 * 4) }
        guard materialValues.allSatisfy(\.isFinite),
              materialValues[0...3].allSatisfy({ $0 >= 0 && $0 <= 1 }),
              materialValues[4...7].allSatisfy({ $0 >= 0 && $0 <= 1 })
        else {
            throw HoseMetalAssetError.invalidMaterial
        }
        let material = Material(
            baseColor: Array(materialValues[0...3]),
            metallic: materialValues[4],
            roughness: materialValues[5],
            coatWeight: materialValues[6],
            coatRoughness: materialValues[7]
        )

        schemaVersion = version
        self.positions = positions
        self.normals = normals
        self.textureCoordinates = textureCoordinates
        self.jointIndices = jointIndices
        self.jointWeights = jointWeights
        self.indices = indices
        self.bindMatrices = bindMatrices
        self.inverseBindMatrices = inverseBindMatrices
        self.correctiveDeltas = correctiveDeltas
        self.material = material
        self.bounds = bounds
        self.layout = layout
    }

    func referenceSkinnedPositions(
        jointMatrices: [simd_float4x4],
        correctiveWeights: SIMD2<Float> = .zero
    ) throws -> [SIMD3<Float>] {
        guard jointMatrices.count == Self.requiredJointCount else {
            throw HoseMetalAssetError.invalidJointMatrixCount
        }
        return positions.indices.map { index in
            var source = positions[index]
            source += correctiveDeltas[0][index] * correctiveWeights.x
            source += correctiveDeltas[1][index] * correctiveWeights.y
            let homogeneous = SIMD4<Float>(source, 1)
            let joints = jointIndices[index]
            let weights = jointWeights[index]
            let first = jointMatrices[Int(joints.x)] * inverseBindMatrices[Int(joints.x)] * homogeneous
            let second = jointMatrices[Int(joints.y)] * inverseBindMatrices[Int(joints.y)] * homogeneous
            return SIMD3<Float>(first.x, first.y, first.z) * weights.x
                + SIMD3<Float>(second.x, second.y, second.z) * weights.y
        }
    }

    private static func expectedOffsets(
        vertexCount: Int,
        indexCount: Int,
        jointCount: Int,
        correctiveCount: Int,
        headerByteCount: Int
    ) throws -> Layout {
        var cursor = headerByteCount
        let positions = cursor
        cursor = try adding(cursor, multiplying(vertexCount, 12))
        let normals = cursor
        cursor = try adding(cursor, multiplying(vertexCount, 12))
        let textureCoordinates = cursor
        cursor = try adding(cursor, multiplying(vertexCount, 8))
        let jointIndices = cursor
        cursor = try adding(cursor, multiplying(vertexCount, 4))
        let jointWeights = cursor
        cursor = try adding(cursor, multiplying(vertexCount, 8))
        let indices = cursor
        cursor = try adding(cursor, multiplying(indexCount, 4))
        let bindMatrices = cursor
        cursor = try adding(cursor, multiplying(jointCount, 64))
        let inverseBindMatrices = cursor
        cursor = try adding(cursor, multiplying(jointCount, 64))
        let correctiveDeltas = cursor
        cursor = try adding(cursor, multiplying(try multiplying(correctiveCount, vertexCount), 12))
        let material = cursor
        cursor = try adding(cursor, 32)
        return Layout(
            positionsOffset: positions,
            normalsOffset: normals,
            textureCoordinatesOffset: textureCoordinates,
            jointIndicesOffset: jointIndices,
            jointWeightsOffset: jointWeights,
            indicesOffset: indices,
            bindMatricesOffset: bindMatrices,
            inverseBindMatricesOffset: inverseBindMatrices,
            correctiveDeltasOffset: correctiveDeltas,
            materialOffset: material,
            payloadOffset: headerByteCount,
            payloadByteCount: cursor - headerByteCount
        )
    }

    private static func adding(_ left: Int, _ right: Int) throws -> Int {
        let (value, overflow) = left.addingReportingOverflow(right)
        guard !overflow else { throw HoseMetalAssetError.invalidLayout }
        return value
    }

    private static func multiplying(_ left: Int, _ right: Int) throws -> Int {
        let (value, overflow) = left.multipliedReportingOverflow(by: right)
        guard !overflow else { throw HoseMetalAssetError.invalidLayout }
        return value
    }

    private static func checkedAdd(_ left: Int, _ right: Int) -> Int? {
        let (value, overflow) = left.addingReportingOverflow(right)
        return overflow ? nil : value
    }

    private static func readMatrices(_ data: Data, offset: Int, count: Int) throws -> [simd_float4x4] {
        var result = [simd_float4x4]()
        result.reserveCapacity(count)
        for matrixIndex in 0..<count {
            let base = offset + matrixIndex * 64
            let values = (0..<16).map { data.float32(at: base + $0 * 4) }
            guard values.allSatisfy(\.isFinite) else { throw HoseMetalAssetError.invalidJointMatrix }
            result.append(simd_float4x4(columns: (
                SIMD4<Float>(values[0], values[1], values[2], values[3]),
                SIMD4<Float>(values[4], values[5], values[6], values[7]),
                SIMD4<Float>(values[8], values[9], values[10], values[11]),
                SIMD4<Float>(values[12], values[13], values[14], values[15])
            )))
        }
        return result
    }

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

private extension Data {
    func uint16(at offset: Int) -> UInt16 {
        withUnsafeBytes { rawBuffer in
            UInt16(littleEndian: rawBuffer.loadUnaligned(fromByteOffset: offset, as: UInt16.self))
        }
    }

    func uint32(at offset: Int) -> UInt32 {
        withUnsafeBytes { rawBuffer in
            UInt32(littleEndian: rawBuffer.loadUnaligned(fromByteOffset: offset, as: UInt32.self))
        }
    }

    func float32(at offset: Int) -> Float {
        Float(bitPattern: uint32(at: offset))
    }

    func float3(at offset: Int) -> SIMD3<Float> {
        SIMD3(float32(at: offset), float32(at: offset + 4), float32(at: offset + 8))
    }
}

private extension SIMD3 where Scalar == Float {
    var allFinite: Bool { x.isFinite && y.isFinite && z.isFinite }
}
