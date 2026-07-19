#include <metal_stdlib>
using namespace metal;

struct HoseFrameUniforms {
    float4x4 worldToClip;
    float2 correctiveWeights;
    float2 padding;
    float4 baseColor;
    float4 material;
    float4 lightDirection;
};

struct HoseVarying {
    float4 position [[position]];
    float3 normal;
    float2 uv;
};

vertex HoseVarying voiceVacHoseVertex(
    uint id [[vertex_id]],
    device const float3 *positions [[buffer(0)]],
    device const float3 *normals [[buffer(1)]],
    device const float2 *uvs [[buffer(2)]],
    device const ushort2 *joints [[buffer(3)]],
    device const float2 *weights [[buffer(4)]],
    device const float3 *positive [[buffer(5)]],
    device const float3 *negative [[buffer(6)]],
    constant float4x4 *skin [[buffer(7)]],
    constant HoseFrameUniforms &frame [[buffer(8)]]) {
    float3 source = positions[id]
        + positive[id] * frame.correctiveWeights.x
        + negative[id] * frame.correctiveWeights.y;
    ushort2 ji = joints[id];
    float2 jw = weights[id];
    float4 world = (skin[ji.x] * float4(source, 1.0)) * jw.x
                 + (skin[ji.y] * float4(source, 1.0)) * jw.y;
    float3x3 normal0 = float3x3(
        skin[ji.x][0].xyz, skin[ji.x][1].xyz, skin[ji.x][2].xyz
    );
    float3x3 normal1 = float3x3(
        skin[ji.y][0].xyz, skin[ji.y][1].xyz, skin[ji.y][2].xyz
    );
    float3 n = normalize((normal0 * normals[id]) * jw.x
                       + (normal1 * normals[id]) * jw.y);
    return { frame.worldToClip * world, n, uvs[id] };
}

fragment float4 voiceVacHoseFragment(
    HoseVarying in [[stage_in]],
    constant HoseFrameUniforms &frame [[buffer(0)]]) {
    constexpr float pi = 3.14159265359;
    float3 n = normalize(in.normal);
    float3 l = normalize(frame.lightDirection.xyz);
    float3 v = float3(0.0, 0.0, 1.0);
    float3 h = normalize(l + v);
    float noL = saturate(dot(n, l));
    float noV = max(saturate(dot(n, v)), 0.0001);
    float noH = saturate(dot(n, h));
    float voH = saturate(dot(v, h));
    float metallic = saturate(frame.material.x);
    float roughness = clamp(frame.material.y, 0.045, 1.0);
    float alphaRoughness = roughness * roughness;
    float alpha2 = alphaRoughness * alphaRoughness;
    float denominator = noH * noH * (alpha2 - 1.0) + 1.0;
    float distribution = alpha2 / max(pi * denominator * denominator, 0.0001);
    float geometryK = ((roughness + 1.0) * (roughness + 1.0)) / 8.0;
    float geometryV = noV / (noV * (1.0 - geometryK) + geometryK);
    float geometryL = noL / (noL * (1.0 - geometryK) + geometryK);
    float3 f0 = mix(float3(0.04), frame.baseColor.rgb, metallic);
    float3 fresnel = f0 + (1.0 - f0) * pow(1.0 - voH, 5.0);
    float3 specular = distribution * geometryV * geometryL * fresnel
                    / max(4.0 * noV * noL, 0.0001);
    float3 diffuseWeight = (1.0 - fresnel) * (1.0 - metallic);
    float3 diffuse = diffuseWeight * frame.baseColor.rgb / pi;

    float coatWeight = saturate(frame.material.z);
    float coatRoughness = clamp(frame.material.w, 0.045, 1.0);
    float coatAlpha = coatRoughness * coatRoughness;
    float coatAlpha2 = coatAlpha * coatAlpha;
    float coatDenominator = noH * noH * (coatAlpha2 - 1.0) + 1.0;
    float coatDistribution = coatAlpha2
        / max(pi * coatDenominator * coatDenominator, 0.0001);
    float coatK = ((coatRoughness + 1.0) * (coatRoughness + 1.0)) / 8.0;
    float coatGeometry = (noV / (noV * (1.0 - coatK) + coatK))
        * (noL / (noL * (1.0 - coatK) + coatK));
    float coatFresnel = 0.04 + 0.96 * pow(1.0 - voH, 5.0);
    float coat = coatWeight * coatDistribution * coatGeometry * coatFresnel
        / max(4.0 * noV * noL, 0.0001);

    // A dielectric clearcoat is a physical layer: reflected coat energy cannot
    // also reach the base material. Attenuate the base BRDF by the coat's
    // angle-dependent Fresnel before adding the coat lobe.
    float baseTransmission = 1.0 - coatWeight * coatFresnel;
    float3 layeredBRDF = (diffuse + specular) * baseTransmission + coat;
    constexpr float3 incidentRadiance = float3(1.35);
    float3 direct = layeredBRDF * noL * incidentRadiance;
    float skyVisibility = saturate(n.y * 0.5 + 0.5);
    float3 ambient = frame.baseColor.rgb * mix(0.035, 0.12, skyVisibility)
        * (1.0 - metallic * 0.65);
    float3 color = direct + ambient;
    float alpha = frame.baseColor.a;
    return float4(color * alpha, alpha);
}
